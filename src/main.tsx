import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { App } from "./App.tsx"
import { ApiApprovalWindow } from "./components/dialogs/api-approval-dialog.tsx"
import { installLimboBridge } from "./lib/limbo-bridge"

const isApprovalWindow = new URLSearchParams(window.location.search).get("window") === "approval"

installLimboBridge({
  handleAppActivation: !isApprovalWindow,
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isApprovalWindow ? <ApiApprovalWindow /> : <App />}
  </StrictMode>
)
