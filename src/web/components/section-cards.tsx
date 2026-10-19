// Summary card composition from shadcn dashboard-01; only real API totals.
import { Card, CardDescription, CardHeader, CardTitle } from "./ui/card";
export function SectionCards({ items }: { items: { label: string; value: string | number }[] }) {
  return (
    <div className="money-grid">
      {items.map((item) => (
        <Card key={item.label} className="@container/card">
          <CardHeader>
            <CardDescription>{item.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">{item.value}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
