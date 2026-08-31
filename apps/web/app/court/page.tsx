import { redirect } from "next/navigation";

export default async function Court({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  const { case: caseId } = await searchParams;
  const destination = caseId ? `/explorer/${encodeURIComponent(caseId)}` : "/explorer";
  redirect(destination as never);
}
