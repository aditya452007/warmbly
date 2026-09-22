# Discovery task

Find real businesses matching the target below. You are one of several
independent agents; other agents cover other lanes, so work ONLY your lane and
do not repeat their queries.

TARGET
- Industry / service: {{business_type}}
- Location: {{location}}
- Custom instructions: {{custom_instructions}}
- Discovery lane: {{lane_id}} - {{lane_label}}
- Lane guidance: {{lane_guidance}}

METHOD (follow your lane, then verify everything the same way):
- Start with 2-4 distinct searches for your lane. Vary the phrasing; do not
  run the same query twice.
- Open the most promising results. For each candidate, fetch its official
  website (homepage + contact/about page) and scrape the contact details
  exactly as published: email from `mailto:` links or contact blocks, phone
  and street address from footers or contact pages.
- Verify the business matches the requested trade AND place. A nearby
  lookalike trade or a branch in another city is a reject, not a lead.
- Check freshness signals (recent reviews, current site content). Stale or
  closed businesses get low confidence or are dropped.

RULES
- Return between 1 and {{max_leads}} leads as a JSON array. Every lead MUST use
  EXACTLY these field names (no variations, no extra wrapping object):
  {"business_name": "...", "website": "https://... or null", "email": "... or null", "phone": "... or null", "address": "... or null", "city": "... or null", "country": "... or null", "source_urls": ["at least one observed URL"], "confidence": 0.0-1.0}
- business_name is required for every lead. `source_urls` must be a non-empty
  array. Everything else may be null.
- website must be the business's own site as observed, or null. Never guess domains.
- email must be an address you actually observed for the business, or null. Never pattern-guess.
- confidence is your 0-1 estimate that this is a real, currently operating,
  matching business with usable contact data. Below 0.5 means weak evidence.
- Do not output offer URLs, HTML, or anything outside the schema.
