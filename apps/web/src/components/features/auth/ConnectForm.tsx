import { useState } from "react";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import { Button } from "../../primitives/Button.tsx";
import { Input } from "../../primitives/Input.tsx";

// Gateway URL + Model used to live here behind a collapsed "Advanced"
// disclosure (2026-09-08). User feedback after seeing it: neither belongs
// on a login screen at all, even hidden — Gateway URL is a deployment-only
// concern (still overridable via `?gateway=` in the page URL, App.tsx's
// `defaultGatewayUrl()` — just no UI control for it anymore) and Model now
// always defaults to the first entry `GET /models` returns (App.tsx's
// `pickDefaultModel()` already auto-selects `models[0]`, this component
// just no longer offers a way to override it). docs/code-rules.md §36.
export function ConnectForm({
  error,
  connecting,
  onLogin,
  onRegister,
}: {
  error: string | null;
  connecting: boolean;
  onLogin: (email: string, password: string) => void;
  onRegister: (email: string, password: string) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  // Real gap fixed 2026-09-10: register used to have no client-side
  // validation at all — a blank email, a too-short password, and a
  // mismatched confirm-password field (which didn't exist) all fell
  // through to one single generic server message ("email và mật khẩu tối
  // thiểu 8 ký tự", `error.invalid_registration_input`) with no way to
  // tell the user which one was actually wrong. This is a SEPARATE error
  // slot from the `error` prop (the real server-side error, e.g. "email
  // already registered") — checked and shown before ever calling
  // `onRegister`, so a bad local input never even reaches the network.
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (mode === "login") {
      onLogin(email, password);
      return;
    }
    setValidationError(null);
    if (!email.trim()) {
      setValidationError(t("auth.emailRequired"));
      return;
    }
    if (password.length < 8) {
      setValidationError(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setValidationError(t("auth.passwordMismatch"));
      return;
    }
    // Real gap fixed 2026-09-08: this used to just fire `onRegister` and
    // leave `mode` alone — after a successful registration the form stayed
    // in "Create account" mode, so submitting again just tried to register
    // the SAME address a second time instead of logging in with it. Switch
    // back to login mode on success (keeping the email, clearing the
    // password — the user still has to type it once to actually log in,
    // same as any real product). The success message itself is a real
    // `sonner` toast (App.tsx's `<Toaster/>`, styled via style.css to match
    // this app's own theme tokens) — `toast()` is a plain function, no
    // context/prop-drilling needed to reach it from here.
    setRegistering(true);
    const ok = await onRegister(email, password);
    setRegistering(false);
    if (ok) {
      setMode("login");
      setPassword("");
      setConfirmPassword("");
      toast.success(t("auth.registerSuccess"));
    }
  }

  const busy = connecting || registering;
  const displayError = validationError ?? error;

  return (
    <div className="fh-auth-card">
      <div className="fh-auth-brand">
        <h1>Fox Harness</h1>
        <p>
          {mode === "login" ? t("auth.loginTitle") : t("auth.registerTitle")}
        </p>
      </div>

      <form
        id="connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <Input
          id="email-input"
          label={t("auth.email")}
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Input
          id="password-input"
          label={t("auth.password")}
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {mode === "register" && (
          <Input
            id="confirm-password-input"
            label={t("auth.confirmPassword")}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        )}

        <Button
          id="connect-submit"
          variant="primary"
          type="submit"
          disabled={busy}
        >
          {busy
            ? t("auth.pleaseWait")
            : mode === "login"
              ? t("auth.login")
              : t("auth.createAccount")}
        </Button>

        {displayError && (
          <span id="connect-error" className="error">
            {displayError}
          </span>
        )}
      </form>

      <Button
        id="register-button"
        variant="link"
        className="fh-auth-switch"
        onClick={() => {
          setMode((m) => (m === "login" ? "register" : "login"));
          setValidationError(null);
        }}
      >
        {mode === "login"
          ? t("auth.switchToRegister")
          : t("auth.switchToLogin")}
      </Button>
    </div>
  );
}
