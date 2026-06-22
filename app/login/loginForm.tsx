"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";

export default function LoginForm() {
  const supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    setLoading(false);
    setMessage(error ? error.message : "Check your email for a magic link.");
  }

  return (
    <form onSubmit={signIn}>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" /></label>
      <button disabled={loading}>{loading ? "Sending..." : "Send magic link"}</button>
      {message && <p>{message}</p>}
    </form>
  );
}
