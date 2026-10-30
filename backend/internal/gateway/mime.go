package gateway

import (
	"bytes"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset"
	"github.com/emersion/go-message/mail"
)

const replyDelimiter = "##- Please type your reply above this line -##"

var reqToken = regexp.MustCompile(`\[#REQ-(\d+)\]`)

type ParsedMail struct {
	From      string
	FromName  string
	To        string
	Subject   string
	MessageID string
	Content   string
	ReplyIDs  []string
	DisplayID int64
	Raw       []byte
}

type OutboundMail struct {
	From      string
	To        string
	Subject   string
	MessageID string
	InReplyTo string
	Content   string
	DisplayID int64
}

func BuildOutboundMIME(in OutboundMail) ([]byte, error) {
	from := normalizeAddr(in.From)
	to := normalizeAddr(in.To)
	if from == "" || to == "" || strings.TrimSpace(in.Content) == "" {
		return nil, ErrInvalid
	}
	var h mail.Header
	h.SetAddressList("From", []*mail.Address{{Address: from}})
	h.SetAddressList("To", []*mail.Address{{Address: to}})
	subj := in.Subject
	if subj == "" {
		subj = "[#REQ-" + strconv.FormatInt(in.DisplayID, 10) + "]"
	} else if extractDisplayID(subj) == 0 && in.DisplayID > 0 {
		subj = subj + " [#REQ-" + strconv.FormatInt(in.DisplayID, 10) + "]"
	}
	h.SetSubject(subj)
	mid := strings.Trim(in.MessageID, "<>")
	if mid == "" {
		return nil, ErrInvalid
	}
	h.SetMessageID(mid)
	if in.InReplyTo != "" {
		parent := strings.Trim(in.InReplyTo, "<>")
		h.SetMsgIDList("In-Reply-To", []string{parent})
		h.SetMsgIDList("References", []string{parent})
	}
	h.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
	var buf bytes.Buffer
	w, err := mail.CreateSingleInlineWriter(&buf, h)
	if err != nil {
		return nil, err
	}
	body := strings.TrimSpace(in.Content) + "\r\n\r\n" + replyDelimiter + "\r\n"
	if _, err := io.WriteString(w, body); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func ParseMIME(raw []byte) (ParsedMail, error) {
	out := ParsedMail{Raw: raw}
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil && !message.IsUnknownCharset(err) {
		return ParsedMail{}, err
	}
	if mr == nil {
		return ParsedMail{}, ErrInvalid
	}
	defer mr.Close()

	if addrs, err := mr.Header.AddressList("From"); err == nil && len(addrs) > 0 {
		out.From = strings.ToLower(strings.TrimSpace(addrs[0].Address))
		out.FromName = strings.TrimSpace(addrs[0].Name)
	}
	if addrs, err := mr.Header.AddressList("To"); err == nil && len(addrs) > 0 {
		out.To = strings.ToLower(strings.TrimSpace(addrs[0].Address))
	}
	if subj, err := mr.Header.Subject(); err == nil {
		out.Subject = subj
	} else {
		out.Subject = mr.Header.Get("Subject")
	}
	if id, err := mr.Header.MessageID(); err == nil {
		out.MessageID = id
	}
	inReply, _ := mr.Header.MsgIDList("In-Reply-To")
	refs, _ := mr.Header.MsgIDList("References")
	seen := map[string]bool{}
	for _, id := range append(inReply, refs...) {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out.ReplyIDs = append(out.ReplyIDs, id)
	}

	var plain, html string
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil && !message.IsUnknownCharset(err) {
			return ParsedMail{}, err
		}
		if p == nil {
			continue
		}
		h, ok := p.Header.(*mail.InlineHeader)
		if !ok {
			_, _ = io.Copy(io.Discard, p.Body)
			continue
		}
		ct, _, _ := h.ContentType()
		body, _ := io.ReadAll(p.Body)
		switch {
		case strings.HasPrefix(strings.ToLower(ct), "text/plain") && plain == "":
			plain = string(body)
		case strings.HasPrefix(strings.ToLower(ct), "text/html") && html == "":
			html = string(body)
		}
	}
	content := plain
	if strings.TrimSpace(content) == "" {
		content = html
	}
	out.Content = StripReply(content)
	out.DisplayID = extractDisplayID(out.Subject)
	if out.DisplayID == 0 {
		out.DisplayID = extractDisplayID(content)
	}
	return out, nil
}

func StripReply(body string) string {
	idx := strings.Index(body, replyDelimiter)
	if idx >= 0 {
		body = body[:idx]
	}
	return strings.TrimSpace(body)
}

func extractDisplayID(s string) int64 {
	m := reqToken.FindStringSubmatch(s)
	if len(m) < 2 {
		return 0
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func normalizeAddr(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(s); err == nil {
		return strings.ToLower(strings.TrimSpace(addr.Address))
	}
	return strings.ToLower(strings.Trim(s, "<>"))
}
