"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result =
      mode === "signup"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });

    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong");
      return;
    }
    setName("");
    setEmail("");
    setPassword("");
  }

  if (isPending) {
    return <p className="p-8 text-gray-500">Loading…</p>;
  }

  if (session) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-2xl font-semibold">You are signed in</h1>
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-gray-500">Name:</dt>
            <dd>{session.user.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500">Email:</dt>
            <dd>{session.user.email}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500">User ID:</dt>
            <dd className="font-mono text-xs">{session.user.id}</dd>
          </div>
        </dl>

        <div className="mt-6 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          This block only renders when a valid session exists.
        </div>

        <div className="mt-6 flex items-center gap-3">
          <Link
            href="/chat"
            className="rounded bg-black px-4 py-2 text-sm text-white hover:bg-gray-800"
          >
            Open chat
          </Link>
          <button
            onClick={() => authClient.signOut()}
            className="rounded border px-4 py-2 text-sm hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold">
        {mode === "signin" ? "Sign in" : "Create account"}
      </h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        {mode === "signup" && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="w-full rounded border px-3 py-2"
          />
        )}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
          className="w-full rounded border px-3 py-2"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          required
          minLength={8}
          className="w-full rounded border px-3 py-2"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>

      <p className="mt-4 text-sm text-gray-600">
        {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
        <button
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="font-medium text-blue-600 underline"
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </main>
  );
}
