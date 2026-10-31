import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { App } from "./App.tsx"
import { ApiApprovalWindow } from "./components/dialogs/api-approval-dialog.tsx"

const isApprovalWindow = new URLSearchParams(window.location.search).get("window") === "approval"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isApprovalWindow ? <ApiApprovalWindow /> : <App />}
  </StrictMode>
)
