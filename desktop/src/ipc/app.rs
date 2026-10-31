use sabine::SabineWindow;
use serde::Deserialize;
use specta::Type;

use crate::api::approval::{TorrentApprovalDecision, TorrentApprovalRequest};
use crate::os;

use super::{App, Empty, command, fail};

#[derive(Deserialize, Type)]
struct OpenExternal {
    url: String,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct ApprovalAnswer {
    request_id: String,
    approved: bool,
    remember: bool,
}

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "app.quit", app, |app, Empty {}| {
        app.quit().map_err(fail)
    });
    let window = command(
        window,
        "app.openExternal",
        app,
        |_, request: OpenExternal| os::shell::open_external(&request.url).map_err(fail),
    );
    let window = command(
        window,
        "approval.pending",
        app,
        |app, Empty {}| -> Result<Option<TorrentApprovalRequest>, _> { Ok(app.approvals.active()) },
    );
    command(
        window,
        "approval.decide",
        app,
        |app, answer: ApprovalAnswer| {
            let decision = TorrentApprovalDecision {
                approved: answer.approved,
                remember: answer.remember,
            };
            Ok(app.approvals.decide(&answer.request_id, decision))
        },
    )
}
