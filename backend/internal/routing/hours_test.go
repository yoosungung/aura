package routing_test

import (
	"testing"
	"time"

	"github.com/yoosungung/aura/internal/routing"
)

func weekdayHours() []byte {
	return []byte(`{"timezone":"Asia/Seoul","week":{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[],"sun":[]}}`)
}

func TestAddBusinessDuration_SkipsWeekend(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		t.Fatal(err)
	}
	// Friday 2026-01-02 17:00 KST + 2h → Monday 10:00
	start := time.Date(2026, 1, 2, 17, 0, 0, 0, loc)
	got := routing.AddBusinessDuration(start, 2*3600, weekdayHours())
	want := time.Date(2026, 1, 5, 10, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestAddBusinessDuration_EmptyIsWallClock(t *testing.T) {
	now := time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC) // Saturday
	got := routing.AddBusinessDuration(now, 3600, []byte(`{}`))
	if !got.Equal(now.Add(time.Hour)) {
		t.Fatalf("got %s", got)
	}
}

func TestOpenNow_WeekendClosed(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		t.Fatal(err)
	}
	sat := time.Date(2026, 1, 3, 10, 0, 0, 0, loc)
	if routing.OpenNow(sat, true, weekdayHours()) {
		t.Fatal("saturday open")
	}
	fri := time.Date(2026, 1, 2, 10, 0, 0, 0, loc)
	if !routing.OpenNow(fri, true, weekdayHours()) {
		t.Fatal("friday closed")
	}
	if !routing.OpenNow(sat, false, weekdayHours()) {
		t.Fatal("disabled should be 24/7")
	}
}
