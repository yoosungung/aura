import { Button } from "./ui/button.jsx";
import { parseApproval } from "../store.js";

export function ApprovalCard({ message, onApprove }) {
  const card = parseApproval(message.content);
  if (!card) {
    return null;
  }
  return (
    <div className="approval-card" role="group" aria-label="AI 승인 요청">
      <p>AI 승인 요청 {card.summary || card.tool_name}</p>
      <Button type="button" size="sm" onClick={() => onApprove(card)}>
        승인 및 실행
      </Button>
    </div>
  );
}
