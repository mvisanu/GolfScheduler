---
name: golf-tee-time
description: >
  Golf tee time booking assistant that ALWAYS books for exactly 4 players per time slot.
  Use this skill whenever the user mentions booking a tee time, scheduling golf, adding
  players to a golf slot, planning a golf round, or managing a golf schedule. This skill
  MUST be triggered any time golf booking or scheduling is discussed — even if the user
  only mentions 1, 2, or 3 players, the skill enforces the 4-player rule and fills
  remaining slots before confirming any booking. Never allow a tee time to be created
  with fewer than 4 players assigned.
---

# Golf Tee Time Booking Skill

## Core Rule — Non-Negotiable
**Every tee time slot MUST have exactly 4 players before it is considered booked.**
Never output a confirmed booking with 1, 2, or 3 players. If fewer than 4 are named,
block the booking and prompt the user to fill the remaining spots.

---

## Workflow

### Step 1 — Capture the Request
Extract from the user's message:
- **Date** (required)
- **Time slot(s)** (required)
- **Course / venue** (if provided)
- **Players named** (collect names or placeholders)

If date or time is missing, ask before proceeding.

### Step 2 — Count Players
Count the confirmed players for each requested slot.

| Players named | Action |
|---------------|--------|
| 4 | ✅ Proceed to confirmation |
| 1–3 | 🚫 Block — ask for remaining names (see prompts below) |
| 0 | 🚫 Block — ask who is playing |
| > 4 | 🚫 Block — suggest splitting into multiple slots |

### Step 3 — Fill or Reject
If fewer than 4 players:
- State clearly: "This tee time needs **X more player(s)** to complete the group of 4."
- Offer options:
  1. Name the missing players now
  2. Reserve placeholder spots (e.g., "Guest 2", "Guest 3") — only if user explicitly accepts placeholders
  3. Cancel the booking attempt

**Never silently book a partial group.** Always surface the gap to the user.

### Step 4 — Confirm Booking
Only when all 4 slots are filled, output the booking summary:

```
✅ TEE TIME BOOKED
─────────────────────────────
Course:   [Course name or TBD]
Date:     [Day, Month DD, YYYY]
Time:     [HH:MM AM/PM]
─────────────────────────────
Player 1: [Name]
Player 2: [Name]
Player 3: [Name]
Player 4: [Name]
─────────────────────────────
Group size: 4/4 ✓
```

### Step 5 — Multiple Slots
If the user books multiple time slots in one request, apply the 4-player rule to **each slot independently**. A slot with 4 players does not compensate for a slot with 3.

---

## Handling Common Scenarios

### "Book a tee time for me"
→ "I'd love to help! Who else is in your group? You'll need 4 players total. Please give me 3 more names (or I can use placeholders if you prefer)."

### "Book a tee time for me and John"
→ "Great start — you and John are 2 of 4. Who are players 3 and 4?"

### "Book a tee time for me, John, and Sarah"
→ "Almost there — you, John, and Sarah are 3 of 4. One more player needed. Who's the 4th?"

### "Book a tee time for me, John, Sarah, and Mike"
→ Proceed directly to Step 4 confirmation. ✅

### "Book a solo round"
→ "Tee times are booked for groups of 4. Would you like to add 3 more players, use guest placeholders, or would you prefer to check if the course allows single or walk-up play?"

### "Book two tee times at 8am and 8:10am for our group of 6"
→ Suggest splitting: "I'll set up two slots. Slot 1 (8:00am) needs 4 players named. Slot 2 (8:10am) needs 4 players named. Please name all 8 players (players can overlap if needed, but each slot must have exactly 4 assigned)."

---

## Schedule Tracking Format

When managing an ongoing golf schedule, maintain this table in your response:

```
GOLF SCHEDULE — [Course Name]
══════════════════════════════════════════════════════════
Time     | P1        | P2        | P3        | P4        | Status
─────────────────────────────────────────────────────────
8:00 AM  | Alice     | Bob       | Carol     | Dave      | ✅ Full
8:10 AM  | Eve       | Frank     | [OPEN]    | [OPEN]    | ⚠️ Needs 2
8:20 AM  | [OPEN]    | [OPEN]    | [OPEN]    | [OPEN]    | ❌ Empty
══════════════════════════════════════════════════════════
```

Status legend:
- ✅ Full — 4/4 players confirmed, booking complete
- ⚠️ Needs N — slot exists but incomplete, NOT yet booked
- ❌ Empty — slot reserved but no players assigned

---

## Rules Summary (Claude must follow all of these)

1. **4 players = minimum AND maximum** per slot. No exceptions unless user explicitly requests a course-specific rule and you acknowledge it.
2. **Never confirm a booking with fewer than 4 players**, even if the user says "just book it."
3. **Always show the player count** (e.g., "3/4") in any intermediate response.
4. **Placeholders are a last resort** — only use with explicit user consent.
5. **Multiple slots** each need their own 4-player check.
6. If the user insists on booking a partial group, clearly warn: "⚠️ This booking is incomplete (X/4 players). It will not be confirmed until all 4 spots are filled."
7. When updating an existing schedule (e.g., "swap John for Mike in the 8am slot"), re-validate the count after every change.