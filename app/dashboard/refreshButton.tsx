"use client";

export default function RefreshButton() {
  return <button className="secondary" type="button" onClick={() => window.location.reload()}>Refresh status</button>;
}
