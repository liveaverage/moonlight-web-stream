use std::time::Duration;

use actix_web::{
    Error, HttpRequest, HttpResponse, get, put,
    rt::spawn,
    web::{Data, Json, Payload, Query},
};
use actix_ws::{CloseCode, CloseReason, Message, MessageStream, Session};
use futures::{FutureExt, StreamExt, select};
use serde::{Deserialize, Serialize};
use tokio::{sync::mpsc, time::timeout};
use tracing::{info, warn};

use crate::app::{
    App,
    clipboard::{
        ClipboardAction, ClipboardAgentToServer, ClipboardBridgeError, ClipboardCommand,
        ClipboardServerToAgent,
    },
    host::HostId,
    user::AuthenticatedUser,
};

#[derive(Debug, Deserialize)]
pub struct ClipboardQuery {
    host_id: u32,
}

#[derive(Debug, Deserialize)]
pub struct ClipboardWriteRequest {
    host_id: u32,
    text: String,
}

#[derive(Debug, Serialize)]
pub struct ClipboardReadResponse {
    text: String,
}

#[derive(Debug, Serialize)]
pub struct ClipboardStatusResponse {
    configured: bool,
}

#[derive(Debug, Serialize)]
struct ClipboardErrorResponse {
    error: &'static str,
}

fn bridge_error_response(error: ClipboardBridgeError) -> HttpResponse {
    match error {
        ClipboardBridgeError::TooLarge => {
            HttpResponse::PayloadTooLarge().json(ClipboardErrorResponse {
                error: "clipboard text exceeds the configured byte limit",
            })
        }
        ClipboardBridgeError::Timeout => {
            HttpResponse::GatewayTimeout().json(ClipboardErrorResponse {
                error: "clipboard companion timed out",
            })
        }
        ClipboardBridgeError::Offline
        | ClipboardBridgeError::Disconnected
        | ClipboardBridgeError::Agent => {
            HttpResponse::ServiceUnavailable().json(ClipboardErrorResponse {
                error: "clipboard companion is unavailable",
            })
        }
    }
}

#[get("/clipboard/status")]
pub async fn get_clipboard_status(
    app: Data<App>,
    mut user: AuthenticatedUser,
    Query(query): Query<ClipboardQuery>,
) -> HttpResponse {
    let host_id = HostId(query.host_id);
    if let Err(error) = user.host(host_id).await {
        return HttpResponse::from_error(error);
    }

    let configured = app
        .config()
        .web_server
        .clipboard_bridge
        .agents
        .iter()
        .any(|agent| agent.host_id == host_id.0);
    HttpResponse::Ok().json(ClipboardStatusResponse { configured })
}

#[get("/clipboard")]
pub async fn get_clipboard(
    app: Data<App>,
    mut user: AuthenticatedUser,
    Query(query): Query<ClipboardQuery>,
) -> HttpResponse {
    let host_id = HostId(query.host_id);
    if let Err(error) = user.host(host_id).await {
        return HttpResponse::from_error(error);
    }

    match app.read_host_clipboard(host_id).await {
        Ok(text) => HttpResponse::Ok().json(ClipboardReadResponse { text }),
        Err(error) => bridge_error_response(error),
    }
}

#[put("/clipboard")]
pub async fn put_clipboard(
    app: Data<App>,
    mut user: AuthenticatedUser,
    Json(request): Json<ClipboardWriteRequest>,
) -> HttpResponse {
    let host_id = HostId(request.host_id);
    if let Err(error) = user.host(host_id).await {
        return HttpResponse::from_error(error);
    }

    match app.write_host_clipboard(host_id, request.text).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(error) => bridge_error_response(error),
    }
}

#[get("/clipboard/agent")]
pub async fn clipboard_agent(
    app: Data<App>,
    request: HttpRequest,
    payload: Payload,
) -> Result<HttpResponse, Error> {
    let (response, session, messages) = actix_ws::handle(&request, payload)?;

    spawn(async move {
        if let Err(error) = run_agent_connection(app, session, messages).await {
            warn!(error = %error, "clipboard companion connection closed");
        }
    });

    Ok(response)
}

async fn run_agent_connection(
    app: Data<App>,
    mut session: Session,
    mut messages: MessageStream,
) -> Result<(), anyhow::Error> {
    let hello = timeout(Duration::from_secs(10), messages.next())
        .await
        .map_err(|_| anyhow::anyhow!("clipboard companion authentication timed out"))?
        .ok_or_else(|| anyhow::anyhow!("clipboard companion closed before authentication"))??;
    let Message::Text(hello) = hello else {
        anyhow::bail!("clipboard companion authentication message must be text");
    };
    let ClipboardAgentToServer::Hello { host_id, token } = serde_json::from_str(&hello)? else {
        anyhow::bail!("clipboard companion did not authenticate first");
    };
    let host_id = HostId(host_id);

    if !app.authorize_clipboard_agent(host_id, &token) {
        session
            .close(Some(CloseReason {
                code: CloseCode::Policy,
                description: Some("unauthorized clipboard companion".to_string()),
            }))
            .await?;
        anyhow::bail!("clipboard companion authentication failed");
    }

    let (command_sender, mut commands) = mpsc::channel::<ClipboardCommand>(8);
    let request_timeout = app.config().web_server.clipboard_bridge.request_timeout;
    let connection_id = app.register_clipboard_agent(host_id, command_sender).await;
    let connection_result = async {
        session
            .text(serde_json::to_string(&ClipboardServerToAgent::Ready)?)
            .await?;
        info!(host_id = host_id.0, "clipboard companion connected");

        loop {
            select! {
                command = commands.recv().fuse() => {
                    let Some(command) = command else {
                        break;
                    };
                    if handle_agent_command(&mut session, &mut messages, command, request_timeout).await.is_err() {
                        break;
                    }
                }
                message = messages.next().fuse() => {
                    match message {
                        Some(Ok(Message::Ping(bytes))) => session.pong(&bytes).await?,
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(error)) => return Err(error.into()),
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }
    .await;

    app.unregister_clipboard_agent(host_id, connection_id).await;
    info!(host_id = host_id.0, "clipboard companion disconnected");
    connection_result
}

async fn handle_agent_command(
    session: &mut Session,
    messages: &mut MessageStream,
    command: ClipboardCommand,
    request_timeout: Duration,
) -> Result<(), ()> {
    let outbound = match command.action {
        ClipboardAction::Read => ClipboardServerToAgent::Read { id: command.id },
        ClipboardAction::Write(text) => ClipboardServerToAgent::Write {
            id: command.id,
            text,
        },
    };

    if session
        .text(serde_json::to_string(&outbound).map_err(|_| ())?)
        .await
        .is_err()
    {
        let _ = command.reply.send(Err(ClipboardBridgeError::Disconnected));
        return Err(());
    }

    loop {
        let message = match timeout(request_timeout, messages.next()).await {
            Ok(message) => message,
            Err(_) => {
                let _ = command.reply.send(Err(ClipboardBridgeError::Timeout));
                return Err(());
            }
        };
        let Some(message) = message else {
            let _ = command.reply.send(Err(ClipboardBridgeError::Disconnected));
            return Err(());
        };
        match message {
            Ok(Message::Text(text)) => {
                let Ok(ClipboardAgentToServer::Response { id, ok, text, .. }) =
                    serde_json::from_str(&text)
                else {
                    continue;
                };
                if id != command.id {
                    continue;
                }
                let reply = if ok {
                    Ok(text)
                } else {
                    Err(ClipboardBridgeError::Agent)
                };
                let _ = command.reply.send(reply);
                return Ok(());
            }
            Ok(Message::Ping(bytes)) => {
                if session.pong(&bytes).await.is_err() {
                    let _ = command.reply.send(Err(ClipboardBridgeError::Disconnected));
                    return Err(());
                }
            }
            Ok(Message::Close(_)) | Err(_) => {
                let _ = command.reply.send(Err(ClipboardBridgeError::Disconnected));
                return Err(());
            }
            _ => {}
        }
    }
}
