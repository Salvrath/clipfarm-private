import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.2.9";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_AUDIENCE = "clipfarm-supabase";
const ALLOWED_REPOSITORY_ID = "1276935478";
const ALLOWED_OWNER_ID = "82416041";
const ALLOWED_WORKFLOW_REF = "Salvrath/clipfarm-private/.github/workflows/clipfarm-worker.yml@refs/heads/main";
const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`));

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing Supabase runtime secrets");

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function authorize(req: Request) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new Error("Missing GitHub OIDC token");

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: GITHUB_ISSUER,
    audience: GITHUB_AUDIENCE,
  });

  if (payload.repository_id !== ALLOWED_REPOSITORY_ID) throw new Error("Repository not allowed");
  if (payload.repository_owner_id !== ALLOWED_OWNER_ID) throw new Error("Repository owner not allowed");
  if (payload.workflow_ref !== ALLOWED_WORKFLOW_REF) throw new Error("Workflow not allowed");
  if (payload.ref !== "refs/heads/main") throw new Error("Only main may run the worker");
  if (payload.runner_environment !== "github-hosted") throw new Error("Runner environment not allowed");
  return payload;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validAssetPath(jobId: string, path: string) {
  return new RegExp(`^${escapeRegex(jobId)}/(?:clip-[1-9][0-9]*\\.mp4|clipfarm-clips\\.zip)$`).test(path);
}

function validSourcePath(jobId: string, path: string) {
  return new RegExp(`^${escapeRegex(jobId)}/source\\.(?:mp4|mov|webm|mkv)$`, "i").test(path);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    await authorize(req);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action || "");

  if (action === "cleanup") {
    const { data: expired, error: expiredError } = await supabase
      .from("jobs")
      .select("id,assets")
      .eq("status", "complete")
      .lt("expires_at", new Date().toISOString())
      .limit(50);
    if (expiredError) return json({ error: expiredError.message }, 500);

    let removed = 0;
    for (const item of expired || []) {
      const paths = Array.isArray(item.assets)
        ? item.assets
            .map((asset: unknown) => (asset && typeof asset === "object" && "path" in asset ? String((asset as { path: unknown }).path) : ""))
            .filter(Boolean)
        : [];
      if (paths.length) {
        const { error: removeError } = await supabase.storage.from("clips").remove(paths);
        if (removeError) return json({ error: removeError.message }, 500);
        removed += paths.length;
      }
      const { error: clearError } = await supabase
        .from("jobs")
        .update({ assets: [], expires_at: null })
        .eq("id", item.id);
      if (clearError) return json({ error: clearError.message }, 500);
    }

    const { data: completedSources, error: sourceReadError } = await supabase
      .from("jobs")
      .select("id,source_path")
      .eq("status", "complete")
      .eq("source_type", "upload")
      .not("source_path", "is", null)
      .limit(50);
    if (sourceReadError) return json({ error: sourceReadError.message }, 500);

    for (const item of completedSources || []) {
      const path = typeof item.source_path === "string" ? item.source_path : "";
      if (!path || !validSourcePath(String(item.id), path)) continue;
      const { error: removeError } = await supabase.storage.from("sources").remove([path]);
      if (removeError) continue;
      await supabase.from("jobs").update({ source_path: null }).eq("id", item.id);
      removed += 1;
    }

    return json({ removed });
  }

  if (action === "claim") {
    const { data: queued, error: readError } = await supabase
      .from("jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (readError) return json({ error: readError.message }, 500);
    if (!queued) return json({ job: null });

    const { data: claimed, error: claimError } = await supabase
      .from("jobs")
      .update({ status: "processing", error_message: null })
      .eq("id", queued.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();
    if (claimError) return json({ error: claimError.message }, 500);
    return json({ job: claimed || null });
  }

  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!jobId) return json({ error: "job_id is required" }, 400);

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,status,clip_count,source_type,source_path")
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) return json({ error: jobError.message }, 500);
  if (!job) return json({ error: "Job not found" }, 404);

  if (action === "source_download_url") {
    if (job.status !== "processing") return json({ error: "Job is not processing" }, 409);
    const sourcePath = typeof job.source_path === "string" ? job.source_path : "";
    if (job.source_type !== "upload" || !validSourcePath(jobId, sourcePath)) {
      return json({ error: "Invalid uploaded source" }, 400);
    }
    const { data, error } = await supabase.storage.from("sources").createSignedUrl(sourcePath, 15 * 60);
    if (error || !data?.signedUrl) return json({ error: error?.message || "Could not sign source download" }, 500);
    return json({ signed_url: data.signedUrl });
  }

  if (action === "upload_urls") {
    if (job.status !== "processing") return json({ error: "Job is not processing" }, 409);
    const paths = Array.isArray(body.paths) ? body.paths.filter((value): value is string => typeof value === "string") : [];
    if (!paths.length || paths.length > Number(job.clip_count) + 1) return json({ error: "Invalid upload paths" }, 400);
    if (paths.some((path) => !validAssetPath(jobId, path))) return json({ error: "Invalid asset path" }, 400);

    const uploads = [];
    for (const path of paths) {
      const { data, error } = await supabase.storage.from("clips").createSignedUploadUrl(path);
      if (error || !data?.token) return json({ error: error?.message || `Could not sign ${path}` }, 500);
      uploads.push({ path, token: data.token });
    }
    return json({ uploads });
  }

  if (action === "complete") {
    if (job.status !== "processing") return json({ error: "Job is not processing" }, 409);
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const expected = Number(job.clip_count) + 1;
    if (assets.length !== expected) return json({ error: `Expected ${expected} assets` }, 400);

    for (const asset of assets) {
      if (!asset || typeof asset !== "object") return json({ error: "Invalid asset" }, 400);
      const record = asset as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path : "";
      const kind = record.kind;
      if (!validAssetPath(jobId, path) || (kind !== "clip" && kind !== "zip")) return json({ error: "Invalid asset" }, 400);
    }

    let sourceRemoved = false;
    const sourcePath = typeof job.source_path === "string" ? job.source_path : "";
    if (job.source_type === "upload" && validSourcePath(jobId, sourcePath)) {
      const { error: sourceRemoveError } = await supabase.storage.from("sources").remove([sourcePath]);
      sourceRemoved = !sourceRemoveError;
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const updatePayload: Record<string, unknown> = {
      status: "complete",
      error_message: null,
      assets,
      expires_at: expiresAt,
    };
    if (sourceRemoved) updatePayload.source_path = null;

    const { error } = await supabase
      .from("jobs")
      .update(updatePayload)
      .eq("id", jobId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, expires_at: expiresAt, source_removed: sourceRemoved });
  }

  if (action === "fail") {
    const message = String(body.error || "Worker failed").slice(0, 4000);
    const { error } = await supabase
      .from("jobs")
      .update({ status: "failed", error_message: message })
      .eq("id", jobId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
