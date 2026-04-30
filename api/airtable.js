// Vercel Serverless Function — Airtable proxy.
// Mirrors the Cowork MCP tool surface used by the frontend so that the original
// artifact code (`cellValuesByFieldId`, `nextCursor`, …) keeps working unchanged.
//
// Frontend posts: { tool: "<name>", params: { ... } }
// Tools mapped:
//   - list_records_for_table   → GET    /v0/{baseId}/{tableId}
//   - create_records_for_table → POST   /v0/{baseId}/{tableId}
//   - update_records_for_table → PATCH  /v0/{baseId}/{tableId}
//
// Auth: AIRTABLE_TOKEN env var (Personal Access Token with data.records:read+write,
// scoped to the configured base). Configure in Vercel → Project → Settings → Environment Variables.

const AIRTABLE_API = "https://api.airtable.com/v0";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({
      error:
        "Server is missing AIRTABLE_TOKEN. Set it in Vercel → Project → Settings → Environment Variables, then redeploy.",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Missing JSON body" });
  }

  const { tool, params } = body;
  if (!tool || !params || typeof params !== "object") {
    return res.status(400).json({ error: "Missing 'tool' or 'params'" });
  }

  try {
    if (tool === "list_records_for_table") {
      return res.status(200).json(await listRecords(token, params));
    }
    if (tool === "create_records_for_table") {
      return res.status(200).json(await mutateRecords(token, params, "POST"));
    }
    if (tool === "update_records_for_table") {
      return res.status(200).json(await mutateRecords(token, params, "PATCH"));
    }
    return res.status(400).json({ error: `Unknown tool: ${tool}` });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return res.status(502).json({ error: msg });
  }
}

async function listRecords(token, params) {
  const { baseId, tableId, pageSize, cursor } = params;
  if (!baseId || !tableId) throw new Error("baseId and tableId are required");

  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);
  // Airtable REST caps pageSize at 100 (the legacy Cowork MCP did not).
  // The frontend asks for 200/500 — we silently clamp and let its cursor
  // loop fetch the rest.
  if (pageSize) {
    const n = Math.max(1, Math.min(100, Number(pageSize) || 100));
    url.searchParams.set("pageSize", String(n));
  }
  if (cursor) url.searchParams.set("offset", String(cursor));
  url.searchParams.set("returnFieldsByFieldId", "true");

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Airtable ${r.status} on list: ${await r.text()}`);
  const data = await r.json();

  return {
    records: (data.records || []).map(reshapeRecord),
    nextCursor: data.offset || null,
  };
}

async function mutateRecords(token, params, method) {
  const { baseId, tableId, records, typecast } = params;
  if (!baseId || !tableId) throw new Error("baseId and tableId are required");
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("records must be a non-empty array");
  }

  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);
  url.searchParams.set("returnFieldsByFieldId", "true");

  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records, typecast: !!typecast }),
  });
  if (!r.ok) throw new Error(`Airtable ${r.status} on ${method}: ${await r.text()}`);
  const data = await r.json();

  return {
    records: (data.records || []).map(reshapeRecord),
  };
}

function reshapeRecord(rec) {
  return {
    id: rec.id,
    createdTime: rec.createdTime,
    cellValuesByFieldId: rec.fields || {},
  };
}
