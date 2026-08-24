use std::{collections::HashMap, time::Duration};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    sync::{RwLock, mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

use super::{App, host::HostId};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClipboardAgentToServer {
    Hello {
        host_id: u32,
        token: String,
    },
    Response {
        id: Uuid,
        ok: bool,
        text: Option<String>,
        error: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClipboardServerToAgent {
    Ready,
    Read { id: Uuid },
    Write { id: Uuid, text: String },
}

#[derive(Debug)]
pub struct ClipboardCommand {
    pub id: Uuid,
    pub action: ClipboardAction,
    pub reply: oneshot::Sender<Result<Option<String>, ClipboardBridgeError>>,
}

#[derive(Debug)]
pub enum ClipboardAction {
    Read,
    Write(String),
}

#[derive(Debug, Error)]
pub enum ClipboardBridgeError {
    #[error("no clipboard companion is connected for this host")]
    Offline,
    #[error("clipboard companion did not respond in time")]
    Timeout,
    #[error("clipboard companion disconnected")]
    Disconnected,
    #[error("clipboard companion rejected the request")]
    Agent,
    #[error("clipboard text exceeds the configured byte limit")]
    TooLarge,
}

struct ClipboardConnection {
    connection_id: Uuid,
    sender: mpsc::Sender<ClipboardCommand>,
}

#[derive(Default)]
pub(super) struct ClipboardAgents {
    connections: RwLock<HashMap<HostId, ClipboardConnection>>,
}

impl App {
    pub fn authorize_clipboard_agent(&self, host_id: HostId, token: &str) -> bool {
        let Some(agent) = self
            .config()
            .web_server
            .clipboard_bridge
            .agents
            .iter()
            .find(|agent| agent.host_id == host_id.0)
        else {
            return false;
        };

        token_matches_hash(agent.token_sha256.trim(), token)
    }

    pub async fn register_clipboard_agent(
        &self,
        host_id: HostId,
        sender: mpsc::Sender<ClipboardCommand>,
    ) -> Uuid {
        let connection_id = Uuid::new_v4();
        self.inner
            .clipboard_agents
            .connections
            .write()
            .await
            .insert(
                host_id,
                ClipboardConnection {
                    connection_id,
                    sender,
                },
            );
        connection_id
    }

    pub async fn unregister_clipboard_agent(&self, host_id: HostId, connection_id: Uuid) {
        let mut connections = self.inner.clipboard_agents.connections.write().await;
        if connections
            .get(&host_id)
            .is_some_and(|connection| connection.connection_id == connection_id)
        {
            connections.remove(&host_id);
        }
    }

    async fn clipboard_request(
        &self,
        host_id: HostId,
        action: ClipboardAction,
    ) -> Result<Option<String>, ClipboardBridgeError> {
        let sender = self
            .inner
            .clipboard_agents
            .connections
            .read()
            .await
            .get(&host_id)
            .map(|connection| connection.sender.clone())
            .ok_or(ClipboardBridgeError::Offline)?;

        let (reply, receive_reply) = oneshot::channel();
        sender
            .send(ClipboardCommand {
                id: Uuid::new_v4(),
                action,
                reply,
            })
            .await
            .map_err(|_| ClipboardBridgeError::Disconnected)?;

        let request_timeout: Duration = self.config().web_server.clipboard_bridge.request_timeout;
        timeout(request_timeout, receive_reply)
            .await
            .map_err(|_| ClipboardBridgeError::Timeout)?
            .map_err(|_| ClipboardBridgeError::Disconnected)?
    }

    pub async fn read_host_clipboard(
        &self,
        host_id: HostId,
    ) -> Result<String, ClipboardBridgeError> {
        let text = self
            .clipboard_request(host_id, ClipboardAction::Read)
            .await?
            .ok_or(ClipboardBridgeError::Agent)?;
        if text.len() > self.config().web_server.clipboard_bridge.max_text_bytes {
            return Err(ClipboardBridgeError::TooLarge);
        }
        Ok(text)
    }

    pub async fn write_host_clipboard(
        &self,
        host_id: HostId,
        text: String,
    ) -> Result<(), ClipboardBridgeError> {
        if text.len() > self.config().web_server.clipboard_bridge.max_text_bytes {
            return Err(ClipboardBridgeError::TooLarge);
        }
        self.clipboard_request(host_id, ClipboardAction::Write(text))
            .await?;
        Ok(())
    }
}

fn token_matches_hash(expected_hex: &str, token: &str) -> bool {
    let Ok(expected) = hex::decode(expected_hex) else {
        return false;
    };
    let actual = Sha256::digest(token.as_bytes());

    expected.len() == actual.len()
        && expected
            .iter()
            .zip(actual.iter())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

#[cfg(test)]
mod tests {
    use super::token_matches_hash;

    #[test]
    fn clipboard_token_hash_matches_case_insensitively() {
        let token = "a sufficiently long clipboard companion token";
        let hash = "016D83EB3D36044288ED230D889B138E6555D424C18802DFB5EC22E2B02B4BBE";

        assert!(token_matches_hash(hash, token));
    }

    #[test]
    fn clipboard_token_hash_rejects_wrong_or_invalid_values() {
        assert!(!token_matches_hash(
            "71f349c5570b03fd135686736a5d8b22c690914188fdb1f9b3cfb2e1261c3234",
            "wrong token"
        ));
        assert!(!token_matches_hash("not hex", "token"));
    }
}
