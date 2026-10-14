import { useState } from "react";
import { KeyRound, Loader2, Lock } from "lucide-react";
import { useApp } from "../app/core.jsx";

/* Admin sign-in. The pages behind it (the Admin dashboard, FM Deliveries, the pipeline's logs) show what only the
   admin needs: errors, what was sent where, every reader, FM's raw feed. */
export default function Login({ what = "the admin pages" }) {
  const { login, adminReady } = useApp();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async e => {
    e.preventDefault();
    if (!pw) return;
    setBusy(true); setErr("");
    try { await login(pw); setPw(""); }
    catch (x) { setErr(String(x.message || x)); }
    setBusy(false);
  };
  return (
    <section className="rp-head">
      <div className="wrap">
        <span className="eyebrow">SportsFC · Admin</span>
        <h1 className="display l">Sign in to <b>continue</b></h1>
        <p className="rp-when">{what[0].toUpperCase() + what.slice(1)} {what.endsWith("s") ? "are" : "is"} for the admin only. The content team's view — which post went out where, and what went wrong — is on <a href="#/live" style={{ color: "var(--red)" }}>Live</a> and <a href="#/report" style={{ color: "var(--red)" }}>Report</a>.</p>
        {adminReady === false
          ? <div className="card login-card"><Lock /><div><b>Admin isn't set up on this site yet.</b><div className="login-sub">Set <code>ADMIN_PASSWORD</code> (10+ characters) in Vercel → Settings → Environment Variables, then redeploy.</div></div></div>
          : <form className="card login-card" onSubmit={submit}>
              <KeyRound />
              <label className="fld login-fld"><span>Admin password</span>
                <input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus /></label>
              <button className="btn btn-red btn-sm" disabled={busy || !pw}>{busy ? <Loader2 className="spin" /> : <Lock />}Sign in</button>
              {err && <div className="login-err">{err}</div>}
            </form>}
      </div>
    </section>
  );
}
