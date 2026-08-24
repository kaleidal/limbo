import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { MarketingApp } from "./marketing-app"
import "./marketing.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MarketingApp />
  </StrictMode>
)
