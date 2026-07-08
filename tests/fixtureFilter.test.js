const assert = require("assert");
const { shouldIncludeFixture } = require("../services/fixtureFilter");

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
];

for (const testCase of cases) {
  const actual = shouldIncludeFixture(testCase.fixture);
  assert.strictEqual(
    actual,
    testCase.expected,
    `${testCase.name}: expected ${testCase.expected}, got ${actual}`,
  );
}

console.log(`fixtureFilter tests passed (${cases.length} cases)`);
