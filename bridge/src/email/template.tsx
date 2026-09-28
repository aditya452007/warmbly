import { Body, Button, Column, Container, Head, Heading, Hr, Html, Img, Preview, Row, Section, Tailwind, Text } from "react-email";

// Master outreach shell. The AI contributes NOTHING to this markup: the body
// arrives as a sentinel replaced post-render with the Warmbly variable, and
// the three offer URLs arrive verbatim from campaign configuration.
// Warmbly renders templates with Go text/template against capitalized keys
// (internal/tasks/template.go: FirstName, Company, ... plus custom fields by
// exact key, missingkey=zero). Lowercase {{.first_name}} would render EMPTY,
// so the greeting uses the exact {{.FirstName}} standard variable.
export const BODY_SENTINEL = "__WARMBLY_AI_BODY__";
export const FIRST_NAME_VAR = "{{.FirstName}}";
export const AI_BODY_VAR = "{{.ai_body}}";

// Fixed sender identity for v2 outreach, mandated by the operator (not AI
// content): header wordmark plus footer signature. Never rendered from AI
// output, never personalized per lead.
export const SENDER_COMPANY = "Shodasha";
export const SENDER_TAGLINE = "From scratch to a brand.";
export const SENDER_SITE_URL = "https://shodasha.vercel.app/";
export const SENDER_LOGO_URL = "https://ik.imagekit.io/shodasha/shodasha-cms/shodasha-logo_MxOa6iz9H.png?tr=w-128%2Cq-80%2Cf-auto";
export const SENDER_NAME = "Aaditya Thakur";
export const SENDER_TITLE = "CEO, Shodasha";
export const SENDER_LINE = "I write to founders I can genuinely help.";
// Deterministic adventurer avatar (open-source DiceBear set, operator-chosen
// seed): no third-party photo is ever passed off as the sender. PNG variant:
// Gmail and Outlook do not render SVG images, so the identical SVG pick
// would arrive as a broken image.
export const SENDER_AVATAR_URL = "https://api.dicebear.com/10.x/adventurer/png?backgroundColor=f3ede4&scale=1.1&seed=vrkuhft4";

export interface OutreachTemplateProps {
  aiBodySentinel?: string;
  // One to three offer URLs, verbatim from campaign configuration. Exactly
  // one button renders per URL: no placeholder buttons, never an empty href.
  offers: string[];
}

const OFFER_LABELS = ["Offer 1", "Offer 2", "Offer 3"];

export function OutreachTemplate({ aiBodySentinel = BODY_SENTINEL, offers }: OutreachTemplateProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "Arial, sans-serif", color: "#1e293b" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "24px" }}>
          <Section>
            <Text style={{ fontSize: "20px", fontWeight: "bold" }}>Warmbly Outreach</Text>
          </Section>
          <Hr />
          <Section>
            <Text>{`Hi ${FIRST_NAME_VAR},`}</Text>
            <Text>{aiBodySentinel}</Text>
          </Section>
          <Section>
            <Text style={{ fontWeight: "bold" }}>A few things that might help:</Text>
            {offers.map((url, i) => (
              <Section key={url}>
                <Button href={url} style={{ background: "#0284c7", color: "#fff", padding: "10px 18px" }}>
                  {OFFER_LABELS[i] ?? `Offer ${i + 1}`}
                </Button>
              </Section>
            ))}
          </Section>
          <Hr />
          <Section>
            <Text style={{ fontSize: "12px", color: "#64748b" }}>
              Best regards,
              <br />
              The Warmbly team
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export interface OfferLink {
  url: string;
  label: string;
}

// Fallback labels by slot when the run carries URLs without labels. Verb
// first, outcome framed, low commitment: never "Offer N", never a calendar
// ask on first touch.
export const OFFER_SLOT_LABELS = ["See how it works", "Get my free review", "Claim your audit"];

export interface OutreachTemplateV2Props {
  aiBodySentinel?: string;
  headline: string;
  preview: string;
  businessName?: string;
  offers: OfferLink[];
}

// Combined outreach shell (v2): three cards — header (logo + bold wordmark +
// tagline), body (greeting, insight heading, proof chips, checklist, up to
// three labeled exits), footer (avatar, caps name, CEO heading, site button).
// Light surfaces only; body text holds AA contrast on white; no purple.
export function OutreachTemplateV2({ aiBodySentinel = BODY_SENTINEL, headline, preview, businessName, offers }: OutreachTemplateV2Props) {
  const [primary, ...rest] = offers;
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-[#eef4fa] font-sans">
          <Container className="mx-auto my-[24px] max-w-[600px]">
            <Section className="rounded-[12px] bg-white p-[24px]">
              <Row>
                <Column className="w-[64px] align-middle">
                  <Img src={SENDER_LOGO_URL} alt="Shodasha" width={56} height={56} className="block rounded-[8px] border-none" />
                </Column>
                <Column className="pl-[12px] align-middle">
                  <Heading className="m-0 text-[20px] font-extrabold uppercase leading-[24px] tracking-[0.12em] text-slate-900">
                    {SENDER_COMPANY}
                  </Heading>
                  <Text className="m-0 mt-[4px] text-[13px] leading-[18px] text-slate-600">{SENDER_TAGLINE}</Text>
                </Column>
              </Row>
            </Section>
            <Section className="mt-[12px] rounded-[12px] bg-white p-[32px]">
              <Text className="m-0 text-[15px] leading-[26px] text-slate-700">{`Hi ${FIRST_NAME_VAR},`}</Text>
              <Text className="mt-[12px] text-[15px] leading-[26px] text-slate-700">{aiBodySentinel}</Text>
              <Heading className="mb-0 mt-[20px] text-[20px] font-bold leading-[28px] text-slate-900">{headline}</Heading>
              <Row className="mt-[16px]">
                {businessName ? (
                  <Column className="w-1/2 rounded-[8px] bg-[#f0f9ff] p-[12px] align-top">
                    <Text className="m-0 text-[13px] font-semibold leading-[20px] text-slate-900">★ Written for {businessName}</Text>
                  </Column>
                ) : null}
                <Column className="w-1/2 rounded-[8px] bg-[#f0f9ff] p-[12px] align-top">
                  <Text className="m-0 text-[13px] font-semibold leading-[20px] text-slate-900">
                    ◆ {offers.length} resource{offers.length === 1 ? "" : "s"} inside
                  </Text>
                </Column>
              </Row>
              <Section className="mt-[16px]">
                <Text className="m-0 text-[14px] leading-[24px] text-slate-700">✓ Why this matters for you</Text>
                <Text className="m-0 mt-[4px] text-[14px] leading-[24px] text-slate-700">✓ What I noticed on your site</Text>
                <Text className="m-0 mt-[4px] text-[14px] leading-[24px] text-slate-700">✓ One clear next step</Text>
              </Section>
              {primary ? (
                <Section className="mt-[20px] text-center">
                  <Button
                    href={primary.url}
                    className="box-border w-full rounded-[8px] bg-sky-700 px-[12px] py-[12px] text-center text-[16px] font-semibold text-white no-underline"
                  >
                    {primary.label}
                  </Button>
                </Section>
              ) : null}
              {rest.length > 0 ? (
                <Row className="mt-[12px]">
                  {rest.map((offer) => (
                    <Column key={offer.url} className="w-1/2 px-[6px] align-top">
                      <Button
                        href={offer.url}
                        className="box-border w-full rounded-[8px] border border-solid border-sky-700 bg-white px-[12px] py-[10px] text-center text-[14px] font-semibold text-sky-700 no-underline"
                      >
                        {offer.label}
                      </Button>
                    </Column>
                  ))}
                </Row>
              ) : null}
              <Text className="mb-0 mt-[12px] text-center text-[12px] leading-[18px] text-slate-500">
                2-minute read, no pitch.
              </Text>
            </Section>
            <Section className="mt-[12px] rounded-[12px] bg-white p-[24px]">
              <Row>
                <Column className="w-[56px] align-top">
                  <Img src={SENDER_AVATAR_URL} alt="Aaditya Thakur" width={48} height={48} className="block rounded-full border-none" />
                </Column>
                <Column className="pl-[12px] align-top">
                  <Heading className="m-0 text-[16px] font-extrabold uppercase leading-[20px] tracking-[0.08em] text-slate-900">
                    {SENDER_NAME.toUpperCase()}
                  </Heading>
                  <Heading className="m-0 mt-[2px] text-[12px] font-bold uppercase leading-[16px] tracking-[0.14em] text-sky-700">
                    CEO
                  </Heading>
                  <Text className="m-0 mt-[6px] text-[13px] leading-[20px] text-slate-600">
                    {SENDER_TITLE} — {SENDER_LINE}
                  </Text>
                </Column>
              </Row>
              <Section className="mt-[16px] text-center">
                <Button
                  href={SENDER_SITE_URL}
                  className="box-border w-full rounded-[8px] border border-solid border-slate-900 bg-white px-[12px] py-[10px] text-center text-[14px] font-semibold text-slate-900 no-underline"
                >
                  {SENDER_SITE_URL.replace(/^https?:\/\//, "")}
                </Button>
              </Section>
              <Text className="m-0 mt-[12px] text-center text-[12px] leading-[18px] text-slate-500">
                Reply &lsquo;stop&rsquo; to opt out.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

// Checklist rows for v3: structure-descriptive lines about the mail itself,
// never fabricated prospect facts.
const V3_CHECKLIST = [
  { title: "Why this matters for you", description: "The leak, named in one short paragraph." },
  { title: "What I noticed on your site", description: "One specific observation, written for your business." },
  { title: "One clear next step", description: "Reply, or tap a button below. Nothing else." },
];

// Newest outreach shell (v3): welcome-email skeleton — open logo header,
// body card, big footer card. V1 and V2 stay untouched below.
export function OutreachTemplateV3({ aiBodySentinel = BODY_SENTINEL, headline, preview, businessName, offers }: OutreachTemplateV2Props) {
  const [primary, ...rest] = offers;
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="m-0 bg-[#eef4fa] p-0 font-sans">
          <Container className="mx-auto max-w-[640px] px-4 pb-6 pt-8">
            <Section className="rounded-[8px] bg-white">
              <Section className="overflow-hidden rounded-[8px] border border-solid border-[#e2e8f0]">
                <Section className="px-10 pb-10 pt-10 text-center">
                  <Img src={SENDER_LOGO_URL} alt="Shodasha" width={200} className="mx-auto block border-none" />
                  <Text className="m-0 mt-[12px] text-[13px] leading-[18px] text-slate-600">{SENDER_TAGLINE}</Text>
                </Section>
                <Section className="px-10 pb-14 text-left">
                  <Text className="m-0 text-[15px] leading-[26px] text-slate-700">{`Hi ${FIRST_NAME_VAR},`}</Text>
                  <Text className="m-0 mt-[12px] text-[15px] leading-[26px] text-slate-700">{aiBodySentinel}</Text>
                  <Heading className="mb-0 mt-[20px] text-[22px] font-bold leading-[30px] text-slate-900">{headline}</Heading>
                  <Row className="mt-[16px]">
                    {businessName ? (
                      <Column className="w-1/2 rounded-[8px] bg-[#f0f9ff] p-[12px] align-top">
                        <Text className="m-0 text-[13px] font-semibold leading-[20px] text-slate-900">★ Written for {businessName}</Text>
                      </Column>
                    ) : null}
                    <Column className="w-1/2 rounded-[8px] bg-[#f0f9ff] p-[12px] align-top">
                      <Text className="m-0 text-[13px] font-semibold leading-[20px] text-slate-900">
                        ◆ {offers.length} resource{offers.length === 1 ? "" : "s"} inside
                      </Text>
                    </Column>
                  </Row>
                  {primary ? (
                    <Section className="mt-[20px] text-left">
                      <Button
                        href={primary.url}
                        className="box-border inline-block rounded-[8px] border-none bg-sky-700 px-5 py-3 text-center text-[15px] font-semibold text-white no-underline"
                      >
                        {primary.label}
                      </Button>
                    </Section>
                  ) : null}
                </Section>
                <Section className="bg-[#f8fafc] px-4 py-10">
                  <Section className="px-6">
                    <Text className="m-0 text-[15px] font-semibold leading-[22px] text-slate-900">Before you tap anything:</Text>
                    <Section className="pt-6">
                      {V3_CHECKLIST.map((item) => (
                        <Section key={item.title} className="border-b border-solid border-[#e2e8f0] py-4">
                          <Row>
                            <Column className="w-[92%] align-top">
                              <Text className="m-0 text-[15px] font-semibold leading-[22px] text-slate-900">{item.title}</Text>
                              <Text className="m-0 mt-1 max-w-[380px] text-[14px] leading-[20px] text-slate-600">{item.description}</Text>
                            </Column>
                            <Column className="w-[8%] text-right align-middle">
                              <Text className="m-0 inline-block align-middle text-[14px] font-bold text-sky-700">✓</Text>
                            </Column>
                          </Row>
                        </Section>
                      ))}
                    </Section>
                  </Section>
                </Section>
                {rest.length > 0 ? (
                  <Section className="px-10 pb-14 pt-10 text-center">
                    <Row>
                      {rest.map((offer) => (
                        <Column key={offer.url} className="w-1/2 px-[6px] align-top">
                          <Button
                            href={offer.url}
                            className="box-border w-full rounded-[8px] border border-solid border-sky-700 bg-white px-[12px] py-[10px] text-center text-[14px] font-semibold text-sky-700 no-underline"
                          >
                            {offer.label}
                          </Button>
                        </Column>
                      ))}
                    </Row>
                    <Text className="mb-0 mt-[12px] text-[12px] leading-[18px] text-slate-500">2-minute read, no pitch.</Text>
                  </Section>
                ) : null}
                <Section className="border-t border-solid border-[#e2e8f0] px-10 py-10">
                  <Row>
                    <Column className="w-[104px] align-middle">
                      <Img src={SENDER_AVATAR_URL} alt="Aaditya Thakur" width={96} height={96} className="block rounded-[12px] border-none" />
                    </Column>
                    <Column className="pl-[16px] align-middle">
                      <Heading className="m-0 text-[20px] font-extrabold uppercase leading-[24px] tracking-[0.08em] text-slate-900">
                        {SENDER_NAME.toUpperCase()}
                      </Heading>
                      <Heading className="m-0 mt-[4px] text-[13px] font-bold uppercase leading-[18px] tracking-[0.14em] text-sky-700">
                        CEO, {SENDER_COMPANY}
                      </Heading>
                      <Text className="m-0 mt-[6px] text-[13px] leading-[20px] text-slate-600">{SENDER_TAGLINE}</Text>
                    </Column>
                  </Row>
                  <Section className="mt-[20px] text-center">
                    <Button
                      href={SENDER_SITE_URL}
                      className="box-border w-full rounded-[8px] bg-slate-900 px-[12px] py-[12px] text-center text-[15px] font-semibold text-white no-underline"
                    >
                      Visit our company website
                    </Button>
                  </Section>
                  <Text className="m-0 mt-[12px] text-[12px] leading-[18px] text-slate-500">
                    Reply &lsquo;stop&rsquo; to opt out.
                  </Text>
                </Section>
              </Section>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
