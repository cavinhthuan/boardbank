import { BrowserRouter, Route, Routes } from "react-router-dom";
import BanksPage from "./pages/BanksPage";
import NewSessionPage from "./pages/NewSessionPage";
import SessionPage from "./pages/SessionPage";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<BanksPage />} />
          <Route path="/banks/:bankId/new-session" element={<NewSessionPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
