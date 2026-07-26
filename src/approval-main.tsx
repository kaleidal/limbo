import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { ApiApprovalDialog } from "@/components/dialogs/api-approval-dialog";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiApprovalDialog />
  </StrictMode>,
);
