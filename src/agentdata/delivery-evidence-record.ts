// Pinned contract: the delivery-landing evidence record a future
// writeDeliveryEvidence/findDeliveryEvidence pair will persist under
// data/<name>/, read by complete-agent's DEAD-branch proof, reap-agent's
// lifecycle checks, and delivery-commit-proof.ts's callers. Reuses the
// existing per-agent JSON-file ledger convention
// (TreeBaseDataService/SquashPreviewDataService) rather than new storage
// machinery. Replaces the `Deliver <name>` commit-message grep as the
// primary landing signal; the grep stays as a fallback for agents whose
// delivery predates this record. Minimal fields needed to answer "did
// <name>'s work land, and where": the target repo, the target branch, and
// the delivered commit hash.
export interface DeliveryEvidenceRecord {
  repo: string;
  targetBranch: string;
  commit: string;
}
