package routing

import (
	"encoding/json"
	"time"
)

type businessHours struct {
	Timezone string                `json:"timezone"`
	Week     map[string][][]string `json:"week"`
}

var dayKeys = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func AddBusinessDuration(now time.Time, seconds int, raw []byte) time.Time {
	hours, ok := parseHours(raw)
	if !ok || seconds <= 0 {
		return now.Add(time.Duration(seconds) * time.Second)
	}
	loc := hoursLoc(hours)
	remaining := time.Duration(seconds) * time.Second
	t := now.In(loc)
	deadline := t.Add(366 * 24 * time.Hour)
	for remaining > 0 && t.Before(deadline) {
		open, close, ok := windowOn(t, hours)
		if !ok || !close.After(t) {
			t = nextMidnight(t)
			continue
		}
		start := t
		if start.Before(open) {
			start = open
		}
		if !close.After(start) {
			t = nextMidnight(t)
			continue
		}
		avail := close.Sub(start)
		if remaining <= avail {
			return start.Add(remaining)
		}
		remaining -= avail
		t = nextMidnight(close)
	}
	return t
}

func OpenNow(now time.Time, enabled bool, raw []byte) bool {
	if !enabled {
		return true
	}
	hours, ok := parseHours(raw)
	if !ok {
		return true
	}
	loc := hoursLoc(hours)
	t := now.In(loc)
	open, close, ok := windowOn(t, hours)
	return ok && !t.Before(open) && t.Before(close)
}

func parseHours(raw []byte) (businessHours, bool) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return businessHours{}, false
	}
	var h businessHours
	if err := json.Unmarshal(raw, &h); err != nil {
		return businessHours{}, false
	}
	if len(h.Week) == 0 {
		return businessHours{}, false
	}
	return h, true
}

func hoursLoc(h businessHours) *time.Location {
	if h.Timezone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(h.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

func windowOn(t time.Time, h businessHours) (open, close time.Time, ok bool) {
	key := dayKeys[int(t.Weekday())]
	slots := h.Week[key]
	if len(slots) == 0 {
		return time.Time{}, time.Time{}, false
	}
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	for _, slot := range slots {
		if len(slot) != 2 {
			continue
		}
		oh, om, ok1 := parseClock(slot[0])
		ch, cm, ok2 := parseClock(slot[1])
		if !ok1 || !ok2 {
			continue
		}
		open = day.Add(time.Duration(oh)*time.Hour + time.Duration(om)*time.Minute)
		close = day.Add(time.Duration(ch)*time.Hour + time.Duration(cm)*time.Minute)
		if close.After(open) {
			return open, close, true
		}
	}
	return time.Time{}, time.Time{}, false
}

func parseClock(s string) (hour, min int, ok bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, 0, false
	}
	hour = int(s[0]-'0')*10 + int(s[1]-'0')
	min = int(s[3]-'0')*10 + int(s[4]-'0')
	if hour < 0 || hour > 23 || min < 0 || min > 59 {
		return 0, 0, false
	}
	return hour, min, true
}

func nextMidnight(t time.Time) time.Time {
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	return day.Add(24 * time.Hour)
}
