function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCricketFixture(fixture) {
  const sportName = normalizeText(
    fixture?.sport?.sportName || fixture?.sport_key || fixture?.sport || "",
  );
  if (sportName.includes("cricket")) return true;
  if (sportName.includes("football") || sportName.includes("soccer"))
    return false;

  const tournamentName = normalizeText(
    fixture?.tournament?.tournamentName ||
      fixture?.league ||
      fixture?.tournament ||
      "",
  );
  if (tournamentName.includes("cricket")) return true;

  const participantsText = normalizeText(
    [
      fixture?.participants?.participant1Name,
      fixture?.participants?.participant2Name,
      fixture?.home_team,
      fixture?.away_team,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (participantsText.includes("cricket")) return true;

  const combinedText = `${tournamentName} ${participantsText}`;
  return /\b(t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match)\b/.test(
    combinedText,
  );
}

function shouldIncludeFixture(fixture) {
  if (!fixture) return false;

  if (!isCricketFixture(fixture)) return false;

  const tournamentName = normalizeText(
    fixture?.tournament?.tournamentName ||
      fixture?.league ||
      fixture?.tournament ||
      "",
  );
  const participantText = normalizeText(
    [
      fixture?.participants?.participant1Name,
      fixture?.participants?.participant2Name,
      fixture?.home_team,
      fixture?.away_team,
    ]
      .filter(Boolean)
      .join(" "),
  );

  const combinedText = `${tournamentName} ${participantText}`;

  const cricketCueRegex =
    /\b(cricket|t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match|icc|world cup|world championship|series|tri series|champions trophy|asia cup|qualifier)\b/;
  const matchTypeRegex =
    /\b(t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match)\b/;
  const internationalRegex =
    /\b(international|world cup|world championship|series|tri series|champions trophy|asia cup|icc|qualifier|trophy)\b/;
  const domesticRegex =
    /\b(ipl|indian premier league|psl|big bash|cpl|bbl|t20 blast|county championship|sheffield shield|domestic|league|one day cup|list a|first class|plunket shield|ranji|victoria|caribbean premier league|major league cricket|mcl|super league|premier league|national league|men's domestic|women's super league|wsl)\b/;

  const hasCricketCue = cricketCueRegex.test(combinedText);
  const hasMatchType = matchTypeRegex.test(combinedText);
  if (!hasCricketCue || !hasMatchType) return false;

  const hasDomesticIndicator = domesticRegex.test(combinedText);
  const hasInternationalIndicator = internationalRegex.test(combinedText);

  if (hasDomesticIndicator && !hasInternationalIndicator) return false;

  return true;
}

module.exports = { shouldIncludeFixture, normalizeText };
