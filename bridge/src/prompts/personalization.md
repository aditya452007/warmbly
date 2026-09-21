# Personalization task

Write a short personalized email body and subject for one verified prospect. Output ONLY the subject/body schema.

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
- No fabricated facts: use only the research above.
- No AI disclosure unless the custom instructions ask for it.
- No spammy hype, no fake urgency, no unsupported claims.
- Plain text only. No HTML, no Markdown, no URLs, no signature, no signoff, no footer, no CTA link. The template adds branding, offers, and signature.
- Subject: single line (no CR/LF), max {{max_subject_chars}} characters.
- Body: max {{max_body_chars}} characters, non-empty.
