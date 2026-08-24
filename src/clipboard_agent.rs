use std::time::Duration;

use arboard::Clipboard;
use futures::{SinkExt, StreamExt};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::{
    app::clipboard::{ClipboardAgentToServer, ClipboardServerToAgent},
    cli::ClipboardAgentArgs,
};

pub async fn run(options: ClipboardAgentArgs) -> Result<(), anyhow::Error> {
    if options.token.len() < 32 {
        anyhow::bail!("clipboard companion token must contain at least 32 characters");
    }

    // Keep this object alive for the lifetime of the process. On Linux, the
    // clipboard owner must stay alive to continue serving copied data.
    let mut clipboard = Clipboard::new()?;
    let mut reconnect_delay = Duration::from_secs(1);

    loop {
        match run_connection(&options, &mut clipboard, &mut reconnect_delay).await {
            Ok(()) => warn!("clipboard companion connection closed"),
            Err(error) => warn!(error = %error, "clipboard companion connection failed"),
        }

        sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(30));

        if reconnect_delay > Duration::from_secs(2) {
            info!(
                delay_seconds = reconnect_delay.as_secs(),
                "retrying clipboard companion"
            );
        }
    }
}

async fn run_connection(
    options: &ClipboardAgentArgs,
    clipboard: &mut Clipboard,
    reconnect_delay: &mut Duration,
) -> Result<(), anyhow::Error> {
    let (mut socket, _) = connect_async(&options.server).await?;
    socket
        .send(Message::Text(
            serde_json::to_string(&ClipboardAgentToServer::Hello {
                host_id: options.host_id,
                token: options.token.clone(),
            })?
            .into(),
        ))
        .await?;

    let ready = socket
        .next()
        .await
        .ok_or_else(|| anyhow::anyhow!("server closed before clipboard authentication"))??;
    let Message::Text(ready) = ready else {
        anyhow::bail!("server returned an invalid clipboard authentication response");
    };
    if !matches!(
        serde_json::from_str::<ClipboardServerToAgent>(&ready)?,
        ClipboardServerToAgent::Ready
    ) {
        anyhow::bail!("server did not accept clipboard companion authentication");
    }
    info!(
        host_id = options.host_id,
        "clipboard companion authenticated"
    );
    *reconnect_delay = Duration::from_secs(1);

    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => {
                let request = serde_json::from_str::<ClipboardServerToAgent>(&text)?;
                let response = match request {
                    ClipboardServerToAgent::Read { id } => match clipboard.get_text() {
                        Ok(text) if text.len() <= options.max_text_bytes => {
                            ClipboardAgentToServer::Response {
                                id,
                                ok: true,
                                text: Some(text),
                                error: None,
                            }
                        }
                        Ok(_) => ClipboardAgentToServer::Response {
                            id,
                            ok: false,
                            text: None,
                            error: Some("clipboard text exceeds the configured byte limit".into()),
                        },
                        Err(_) => ClipboardAgentToServer::Response {
                            id,
                            ok: false,
                            text: None,
                            error: Some("desktop clipboard is unavailable".into()),
                        },
                    },
                    ClipboardServerToAgent::Write { id, text } => {
                        let (ok, error) = if text.len() <= options.max_text_bytes {
                            match clipboard.set_text(text) {
                                Ok(()) => (true, None),
                                Err(_) => (false, Some("desktop clipboard is unavailable".into())),
                            }
                        } else {
                            (
                                false,
                                Some("clipboard text exceeds the configured byte limit".into()),
                            )
                        };
                        ClipboardAgentToServer::Response {
                            id,
                            ok,
                            text: None,
                            error,
                        }
                    }
                    ClipboardServerToAgent::Ready => continue,
                };
                socket
                    .send(Message::Text(serde_json::to_string(&response)?.into()))
                    .await?;
            }
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Close(_) => break,
            _ => {}
        }
    }

    Ok(())
}
