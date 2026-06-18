import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignInButton } from "@/components/sign-in-button";

// Already authenticated? Skip the gate.
export default async function SignInPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/");

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-border/70 bg-card/40 p-8 shadow-xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="ember-glow flex size-11 items-center justify-center rounded-md border border-ember/40 bg-ember/10 font-mono text-[18px] text-ember">
            <span aria-hidden>&gt;_</span>
          </div>
          <div className="leading-tight">
            <h1 className="font-mono font-semibold text-[15px] tracking-tight">
              serverless<span className="text-ember">-cc</span>
            </h1>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              sign in to run claude code
            </p>
          </div>
        </div>
        <div className="mt-7">
          <SignInButton />
        </div>
        <p className="mt-5 text-center font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          GitHub OAuth only. We store your name, email, and avatar to keep your
          session.
        </p>
      </div>
    </div>
  );
}
