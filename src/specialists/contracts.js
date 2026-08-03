export const SPECIALIST_POLICY_VERSION = "2026-08-02.1";

const commonCapabilities = Object.freeze([
  "memory.read",
  "memory.search",
  "memory.propose",
  "continuity.read",
  "continuity.write",
  "skills.retrieval",
  "mandates.read",
  "mandates.ack",
  "exchanges.inbox",
  "exchanges.ack",
  "exchanges.reply",
  "exchanges.artifact.read.own",
]);

function contract({ id, aliases = [], domainId, capabilities = [], prohibited = [] }) {
  return Object.freeze({
    specialist_id: id,
    aliases: Object.freeze(aliases),
    domain_ids: Object.freeze([domainId]),
    capabilities: Object.freeze([...commonCapabilities, ...capabilities]),
    lane_permissions: Object.freeze(["root-local", "savae-routed"]),
    prohibited_capabilities: Object.freeze([
      "memory.publish",
      "memory.delete",
      "root.recovery",
      "lanes.read-any",
      ...prohibited,
    ]),
  });
}

export const SPECIALIST_CONTRACTS = Object.freeze({
  ariadne: contract({
    id: "ariadne",
    domainId: "logic-trend-analysis",
    capabilities: ["analysis.current-sources", "ariadne.core.openai_test"],
    prohibited: ["mandates.dispatch", "security.certify"],
  }),
  haava: contract({
    id: "haava",
    domainId: "visual-design-expression",
    capabilities: ["visual.produce"],
    prohibited: ["mandates.dispatch", "security.certify"],
  }),
  hearken: contract({
    id: "hearken",
    domainId: "software-formal-logic",
    capabilities: ["engineering.execute"],
    prohibited: ["mandates.dispatch", "security.certify"],
  }),
  nadeem: contract({
    id: "nadeem",
    domainId: "professional-communication",
    capabilities: ["communication.draft"],
    prohibited: ["mandates.dispatch", "communication.send-unapproved"],
  }),
  savae: contract({
    id: "savae",
    domainId: "mesh-orchestration",
    capabilities: [
      "mandates.draft",
      "mandates.dispatch",
      "mandates.status",
      "router.status",
      "exchanges.dispatch",
      "exchanges.history",
      "exchanges.artifact.read.any",
    ],
    prohibited: ["root.control", "root-local.observe-unforwarded"],
  }),
  synn: contract({
    id: "synn",
    domainId: "security-compliance-preflight",
    capabilities: ["security.preflight", "security.alarm"],
    prohibited: ["mandates.dispatch", "security.override", "remediation.execute"],
  }),
  vitruvius: contract({
    id: "vitruvius",
    aliases: ["uix"],
    domainId: "ui-ux-full-stack",
    capabilities: ["ui.execute"],
    prohibited: ["mandates.dispatch", "security.certify"],
  }),
});
