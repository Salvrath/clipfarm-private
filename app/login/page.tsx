import { redirect } from "next/navigation";
import { serverSupabase } from "@/lib/supabaseServer";
import LoginForm from "./loginForm";

export default async function LoginPage() {
  const supabase = serverSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (session) redirect("/dashboard");
  return (
    <main className="container">
      <div className="card" style={{ maxWidth: 520 }}>
        <h2>Sign in to ClipFarm</h2>
        <p>This app is intended for one private user. Create your Supabase email/password user, then disable public signups.</p>
        <LoginForm />
      </div>
    </main>
  );
}
