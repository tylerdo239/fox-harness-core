import { useState } from "react";

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
//
// Login only: self-registration is gone (POST /auth/register is admin-only
// in services/gateway) — an admin creates accounts in Settings > Users.
export function ConnectForm({
  error,
  connecting,
  onLogin,
}: {
  error: string | null;
  connecting: boolean;
  onLogin: (email: string, password: string) => void;
}) {
  const { t } = useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="fh-auth-card">
      <div className="fh-auth-brand">
        <h1>Fox Harness</h1>
        <p>{t("auth.loginTitle")}</p>
      </div>

      <form
        id="connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          onLogin(email, password);
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
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <Button
          id="connect-submit"
          variant="primary"
          type="submit"
          disabled={connecting}
        >
          {connecting ? t("auth.pleaseWait") : t("auth.login")}
        </Button>

        {error && (
          <span id="connect-error" className="error">
            {error}
          </span>
        )}
      </form>
    </div>
  );
}
