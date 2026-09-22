import { Body, Button, Container, Head, Hr, Html, Section, Text } from "react-email";

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
