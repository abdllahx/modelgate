import { ExtractForm } from "./extract-form";

export default function Home() {
  return (
    <>
      <h1>Extract a receipt</h1>
      <p className="muted">
        Upload a photo or scan. ModelGate routes it across vision models with retries and fallback, validates the result, and
        charges it to the monthly budget.
      </p>
      <ExtractForm />
    </>
  );
}
