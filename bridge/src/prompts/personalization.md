# Personalization task

Write a short personalized email body and subject for one verified prospect.
Return EXACTLY this JSON shape (field names are contractual):
{"subject": "single line, no line breaks", "body": "plain text, no HTML, no URLs, no signature"}

Output ONLY that object.

PROSPECT
- Business: {{business_name}}
- Website: {{website}}
- Location: {{location}}
- Industry: {{business_type}}
- Research summary: {{research_summary}}
- Pain points: {{pain_points}}
- Observed facts: {{facts}}
- Custom instructions: {{custom_instructions}}

RULES
- Personalized, concise, professional, human sounding. No generic praise.
- Open with ONE concrete observed detail (a service, a location note, something
  from the research) — never "I love what you're doing" or any sentence that
  would fit a different business unchanged.
- No fabricated facts: use only the research above. If the research is thin,
  write a shorter honest email, not a longer invented one.
- No AI disclosure unless the custom instructions ask for it.
- No spammy hype, no fake urgency, no unsupported claims.
- Plain text only. No HTML, no Markdown, no URLs, no signature, no signoff, no footer, no CTA link. The template adds branding, offers, and signature.
- Subject: single line (no CR/LF), max {{max_subject_chars}} characters.
- Body: max {{max_body_chars}} characters, non-empty.
