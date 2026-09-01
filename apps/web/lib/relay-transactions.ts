export function mandateTransactionFields(jobType: string, transactionHash?: string) {
  if (!transactionHash) return {};
  if (jobType === "CREATE_MANDATE") return { baseTransactionHash: transactionHash, createTransactionHash: transactionHash };
  if (jobType === "ACCEPT_MANDATE") return { acceptTransactionHash: transactionHash };
  if (jobType === "SUBMIT_DELIVERY") return { deliveryTransactionHash: transactionHash };
  if (jobType === "LINK_CASE") return { linkCaseTransactionHash: transactionHash };
  if (jobType === "RECORD_ACCEPTED") return { acceptedRecordTransactionHash: transactionHash };
  if (jobType === "RECORD_APPEAL") return { appealRecordTransactionHash: transactionHash };
  if (jobType === "RECORD_FINALIZED") return { finalizedRecordTransactionHash: transactionHash };
  if (jobType === "SETTLEMENT") return { settlementTransactionHash: transactionHash, settledAt: new Date() };
  return {};
}
