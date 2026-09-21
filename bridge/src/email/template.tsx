import { Body, Button, Container, Head, Hr, Html, Section, Text } from "@react-email/components";

// Master outreach shell. The AI contributes NOTHING to this markup: the body
// arrives as a sentinel replaced post-render with the Warmbly variable, and
// the three offer URLs arrive verbatim from campaign configuration.
export const BODY_SENTINEL = "__WARMBLY_AI_BODY__";
export const FIRST_NAME_VAR = "{{.first_name}}";
export const AI_BODY_VAR = "{{.ai_body}}";

export interface OutreachTemplateProps {
  aiBodySentinel?: string;
  offers: [string, string, string];
}

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
            <Section>
              <Button href={offers[0]} style={{ background: "#0284c7", color: "#fff", padding: "10px 18px" }}>
                Offer 1
              </Button>
            </Section>
            <Section>
              <Button href={offers[1]} style={{ background: "#0284c7", color: "#fff", padding: "10px 18px" }}>
                Offer 2
              </Button>
            </Section>
            <Section>
              <Button href={offers[2]} style={{ background: "#0284c7", color: "#fff", padding: "10px 18px" }}>
                Offer 3
              </Button>
            </Section>
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
