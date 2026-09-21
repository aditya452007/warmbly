# Discovery task

Find real businesses matching the target below. Use the discovery lane you were assigned; do not repeat the other lanes' queries.

TARGET
- Industry / service: {{business_type}}
- Location: {{location}}
- Custom instructions: {{custom_instructions}}
- Discovery lane: {{lane_id}} - {{lane_label}}
- Lane guidance: {{lane_guidance}}

RULES
- Return between 1 and {{max_leads}} leads as a JSON array matching the lead schema.
- business_name and a source URL are required for every lead. Everything else may be null.
- website must be the business's own site as observed, or null. Never guess domains.
- email must be an address you actually observed for the business, or null. Never pattern-guess.
- confidence is your 0-1 estimate that this is a real matching business with usable contact data.
- Do not output offer URLs, HTML, or anything outside the schema.
