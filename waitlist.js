// /api/waitlist.js
// Vercel serverless function: Tally webhook → MailerLite subscriber
//
// Env vars required (set in Vercel dashboard):
//   MAILERLITE_API_TOKEN   - your MailerLite API token
//   MAILERLITE_GROUP_NAME  - the group name to add subscribers to (default: "Urivia Waitlist — Founding Members")
//
// Tally sends a POST with this structure:
//   { eventId, eventType: "FORM_RESPONSE", createdAt, data: { fields: [{ key, label, type, value, ... }] } }

const MAILERLITE_API = "https://connect.mailerlite.com/api";

// Cache the group ID across warm invocations (Vercel keeps the module loaded between requests)
let cachedGroupId = null;

async function getGroupId(token, groupName) {
  if (cachedGroupId) return cachedGroupId;

  const res = await fetch(`${MAILERLITE_API}/groups?limit=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MailerLite groups fetch failed: ${res.status} ${body}`);
  }

  const json = await res.json();
  const group = (json.data || []).find((g) => g.name === groupName);

  if (!group) {
    throw new Error(
      `Group "${groupName}" not found in MailerLite. Groups found: ${(json.data || [])
        .map((g) => g.name)
        .join(", ")}`
    );
  }

  cachedGroupId = group.id;
  return cachedGroupId;
}

function extractFields(tallyPayload) {
  const fields = tallyPayload?.data?.fields || [];
  const out = { email: null, firstName: null, describesYou: null };

  for (const f of fields) {
    const label = (f.label || "").toLowerCase();

    if (f.type === "INPUT_EMAIL" || label.includes("email")) {
      out.email = f.value;
    } else if (label.includes("first name") || label.includes("name")) {
      out.firstName = f.value;
    } else if (label.includes("describes you")) {
      // Multiple choice - Tally sends either the option text or an array
      if (Array.isArray(f.value)) {
        // For MULTIPLE_CHOICE, value is an array of selected option IDs; resolve via options
        const selected = f.value[0];
        const match = (f.options || []).find((o) => o.id === selected);
        out.describesYou = match ? match.text : null;
      } else {
        out.describesYou = f.value;
      }
    }
  }

  return out;
}

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.MAILERLITE_API_TOKEN;
  const groupName = process.env.MAILERLITE_GROUP_NAME || "Urivia Waitlist — Founding Members";

  if (!token) {
    console.error("MAILERLITE_API_TOKEN is not set");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  try {
    const { email, firstName, describesYou } = extractFields(req.body);

    if (!email) {
      return res.status(400).json({ error: "No email in submission" });
    }

    // Look up group ID (cached after first call)
    const groupId = await getGroupId(token, groupName);

    // Add or update the subscriber
    const subscriberPayload = {
      email,
      fields: {
        name: firstName || "",
        describes_you: describesYou || "",
      },
      groups: [groupId],
      status: "active",
    };

    const mlRes = await fetch(`${MAILERLITE_API}/subscribers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(subscriberPayload),
    });

    const mlBody = await mlRes.json();

    if (!mlRes.ok) {
      console.error("MailerLite error:", mlRes.status, mlBody);
      return res.status(502).json({
        error: "MailerLite rejected subscriber",
        details: mlBody,
      });
    }

    console.log(`Added ${email} to group ${groupName} (${groupId})`);
    return res.status(200).json({ ok: true, email, groupId });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
