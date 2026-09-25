import { useEffect } from "react";
// Interop-safe accessor for react-turnstile under Vite 8 (see lib/turnstile.ts
// for why the direct import hands back the CJS exports object instead of the
// component).
import { Turnstile as TurnstileWidget } from "@/lib/turnstile";
import { TURNSTILE_KEY } from "@/lib/information";

interface Props {
    setToken: (token: string) => void;
}

export default function Turnstile({setToken}: Props) {
    const defaultDevBypassToken = "warmbly-local-turnstile-bypass";
    const bypassToken = import.meta.env.DEV
        ? (import.meta.env.VITE_TURNSTILE_BYPASS_TOKEN?.trim() || defaultDevBypassToken)
        : "";

    useEffect(() => {
        if (bypassToken) setToken(bypassToken);
    }, [bypassToken, setToken]);

    // A deployment that configured no sitekey has no captcha. Rendering the
    // widget anyway makes Cloudflare reject the empty parameter.
    if (bypassToken || !TURNSTILE_KEY) return null;

    return <>
        <TurnstileWidget
            sitekey={TURNSTILE_KEY}
            onVerify={(token: string) => setToken(token)}
            onExpire={() => setToken("")}
            theme={"light"}
        />
    </>
}
