const assert = require("assert");
const { shouldIncludeFixture, selectDisplayableFixtures } = require("../services/fixtureFilter");

const referenceNow = new Date("2026-07-08T12:00:00Z");

const cases = [
  {
    name: "includes men international T20",
    fixture: {
      fixtureId: "1",
      tournament: { tournamentName: "International - Twenty20 International" },
      participants: { participant1Name: "India", participant2Name: "England" },
    },
    expected: true,
  },
  {
    name: "includes women international ODI",
    fixture: {
      fixtureId: "2",
      tournament: { tournamentName: "ICC Women's ODI World Cup" },
      participants: {
        participant1Name: "Australia Women",
        participant2Name: "India Women",
      },
    },
    expected: true,
  },
  {
    name: "includes men international test match",
    fixture: {
      fixtureId: "3",
      tournament: { tournamentName: "International - Test Match" },
      participants: {
        participant1Name: "England",
        participant2Name: "South Africa",
      },
    },
    expected: true,
  },
  {
    name: "excludes domestic IPL match",
    fixture: {
      fixtureId: "4",
      tournament: { tournamentName: "Indian Premier League" },
      participants: {
        participant1Name: "Mumbai Indians",
        participant2Name: "Chennai Super Kings",
      },
    },
    expected: false,
  },
  {
    name: "excludes domestic T20 Blast",
    fixture: {
      fixtureId: "5",
      tournament: { tournamentName: "T20 Blast" },
      participants: { participant1Name: "Essex", participant2Name: "Kent" },
    },
    expected: false,
  },
  {
    name: "excludes non-cricket fixture",
    fixture: {
      fixtureId: "6",
      tournament: { tournamentName: "International - Twenty20 International" },
      participants: { participant1Name: "India", participant2Name: "England" },
      sport: { sportName: "Football" },
    },
    expected: false,
  },
  {
    name: "excludes fixtures beyond the next two days",
    fixture: {
      fixtureId: "7",
      startTime: Math.floor(referenceNow.getTime() / 1000) + 3 * 24 * 60 * 60,
      tournament: { tournamentName: "International - Twenty20 International" },
      participants: { participant1Name: "India", participant2Name: "England" },
    },
    expected: false,
  },
];

for (const testCase of cases) {
  const actual = shouldIncludeFixture(testCase.fixture, referenceNow);
  assert.strictEqual(
    actual,
    testCase.expected,
    `${testCase.name}: expected ${testCase.expected}, got ${actual}`,
  );
}

const cappedFixtures = Array.from({ length: 10 }, (_, index) => ({
  fixtureId: `cap-${index}`,
  startTime: Math.floor(referenceNow.getTime() / 1000) + 60,
  tournament: { tournamentName: "International - Twenty20 International" },
  participants: { participant1Name: `Team ${index}`, participant2Name: `Team ${index + 1}` },
  hasOdds: true,
}));

const capped = selectDisplayableFixtures(cappedFixtures, {
  now: referenceNow,
  limit: 7,
  requireOdds: true,
});
assert.strictEqual(capped.length, 7, `expected capped fixtures to be 7, got ${capped.length}`);

console.log(`fixtureFilter tests passed (${cases.length + 1} cases)`);
