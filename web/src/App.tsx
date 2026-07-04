import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import BanksPage from "./pages/BanksPage";
import NewSessionPage from "./pages/NewSessionPage";
import SessionPage from "./pages/SessionPage";
import LoginPage from "./pages/LoginPage";
import JoinPage from "./pages/JoinPage";
import PlayerPage from "./pages/PlayerPage";
import type { ReactNode } from "react";

function Guard({ need, children }: { need: "admin" | "player"; children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-6 text-slate-400">Đang tải…</div>;
  if (!me) return <Navigate to={need === "admin" ? "/login" : "/join"} replace />;
  if (me.type !== need) return <Navigate to={me.type === "admin" ? "/" : "/play"} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/join" element={<JoinPage />} />
            <Route
              path="/"
              element={
                <Guard need="admin">
                  <BanksPage />
                </Guard>
              }
            />
            <Route
              path="/banks/:bankId/new-session"
              element={
                <Guard need="admin">
                  <NewSessionPage />
                </Guard>
              }
            />
            <Route
              path="/sessions/:id"
              element={
                <Guard need="admin">
                  <SessionPage />
                </Guard>
              }
            />
            <Route
              path="/play"
              element={
                <Guard need="player">
                  <PlayerPage />
                </Guard>
              }
            />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
