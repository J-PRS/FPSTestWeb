/** The VGS chord tree — pure data. Split from vgs.ts: editing a line
 *  or category shouldn't re-read the input plumbing. */

export type VgsNode = { label: string } & ({ line: string; team?: boolean } | { children: Record<string, VgsNode> });

const cat = (label: string, children: Record<string, VgsNode>): VgsNode => ({ label, children });
const line = (label: string, text?: string, team = true): VgsNode => ({ label, line: text ?? `${label}!`, team });
const say = (label: string, text?: string): VgsNode => line(label, text, false);

export const TREE: Record<string, VgsNode> = {
  G: cat('Global', {
    // VG* is all-chat in canon — compliments/responds/taunts are for
    // the whole server, team scoping them hides the shit-talk entirely.
    C: cat('Compliment', {
      A: say('Awesome'),
      G: say('Good game'),
      N: say('Nice move'),
      S: say('Great shot'),
      Y: say('You rock'),
    }),
    R: cat('Respond', {
      A: say('Any time'),
      D: say("Don't know", "I don't know."),
      T: say('Thanks'),
      W: say('Wait'),
    }),
    T: cat('Taunt', {
      A: say('Awww', "Awww, that's too bad!"),
      B: say('Best you can do?', 'Is that the best you can do?'),
      G: say('I am the greatest!'),
      T: say('THAT was graceful!'),
      W: say('When will you learn?'),
    }),
    Y: say('Yes'),
    N: say('No'),
    H: say('Hi'),
    B: say('Bye'),
    O: say('Ooops'),
    Q: say('Quiet'),
    S: say('Shazbot', 'SHAZBOT!'),
    W: say('Woohoo'),
  }),
  A: cat('Attack', {
    A: line('Attack'),
    B: line('Base', 'Attack the enemy base!'),
    C: line('Chase', 'Chase the enemy flag carrier!'),
    D: line('Disrupt', 'Disrupt the enemy defense!'),
    F: line('Flag', 'Get the enemy flag!'),
    G: line('Generator', 'Destroy the enemy generator!'),
    R: line('Reinforce', 'Reinforce the offense!'),
    S: line('Sensors', 'Destroy the enemy sensors!'),
    T: line('Turrets', 'Destroy enemy turrets!'),
    V: line('Vehicle', 'Destroy the enemy vehicle!'),
    W: line('Wait', 'Wait for my signal before attacking.'),
  }),
  D: cat('Defend', {
    D: line('Defend'),
    B: line('Base', 'Defend our base!'),
    C: line('Flag carrier', 'Defend the flag carrier!'),
    E: line('Entrances', 'Defend the entrances!'),
    F: line('Flag', 'Defend our flag!'),
    G: line('Generator', 'Defend our generator!'),
    M: line('Me', 'Cover me!'),
    R: line('Reinforce', 'Reinforce our defense!'),
    S: line('Sensors', 'Defend our sensors!'),
    T: line('Turrets', 'Defend our turrets!'),
    V: line('Vehicle', 'Defend our vehicle!'),
  }),
  F: cat('Flag', {
    D: line('Defend', 'Defend our flag!'),
    F: line('I have the flag', 'I have the flag!'),
    G: line('Give me', 'Give me the flag!'),
    Q: line("I'll retrieve", "I'll retrieve our flag!"),
    R: line('Retrieve', 'Retrieve our flag!'),
    S: line('Secure', 'Our flag is secure!'),
    T: line('Take', 'Take the flag from me!'),
  }),
  N: cat('Need', {
    C: line('Covering fire', 'Need covering fire.'),
    D: line('Driver', 'I need a driver.'),
    E: line('Escort', 'I need an escort.'),
    // Canon VNH is "Hold that vehicle!" — no vehicles yet, so the hold
    // lands on a position instead.
    H: line('Hold', "Hold that position! I'm coming!"),
    N: line('Nuggets', 'I need nuggets!'),
    R: line('Ride', 'I need a ride!'),
    S: line('Support', 'I need support!'),
    V: line('Vehicle', 'Vehicle ready. Need a ride?'),
    W: line('Where to?'),
  }),
  B: cat('Base', {
    C: line('Clear', 'Our base is clear.'),
    E: line('Enemy in base', 'The enemy is in our base!'),
    R: line('Retake', 'Retake our base!'),
    S: line('Secure', 'Secure our base!'),
  }),
  E: cat('Enemy', {
    D: line('Disarray', 'The enemy is in disarray!'),
    G: line('Generator destroyed', 'The enemy generator is destroyed!'),
    S: line('Sensors destroyed', 'The enemy sensors are destroyed!'),
    T: line('Turrets destroyed', 'The enemy turrets are destroyed!'),
    V: line('Vehicle destroyed', 'The enemy vehicle is destroyed!'),
  }),
  R: cat('Repair', {
    G: line('Generator', 'Repair our generator!'),
    S: line('Sensors', 'Repair our sensors!'),
    T: line('Turrets', 'Repair our turrets!'),
    V: line('Vehicle', 'Repair the vehicle!'),
  }),
  C: cat('Command', {
    A: line('Acknowledged'),
    C: line('Completed'),
    D: line('Declined'),
    W: line('Assignment?', "What's my assignment?"),
  }),
  T: cat('Target', {
    A: line('Acquired', 'Target acquired!'),
    B: line('Base', "Target the enemy base! I'm in position."),
    D: line('Destroyed', 'Target destroyed!'),
    F: line('Flag carrier', 'Target the flag carrier!'),
    G: line('Generator', 'Target the generator!'),
    M: line('Me', 'Target me!'),
    N: line('Need painted', 'I need a target painted!'),
    S: line('Sensors', 'Target the sensors!'),
    T: line('Turret', "Target the turret! I'm in position."),
    V: line('Vehicle', "Target the vehicle! I'm in position."),
    W: line('Wait', 'Wait — target not yet.'),
  }),
  W: cat('Warning', {
    B: line('Behind us', 'Watch — enemies behind us!'),
    C: line('Cover', 'Take cover!'),
    E: line('Enemies', 'Incoming hostiles!'),
    F: line('Fall back', 'Fall back!'),
    I: line('Incoming', 'Incoming!'),
    L: line('Look out', 'Look out!'),
    O: line('Overhead', 'Incoming from above!'),
    S: line('Spotted', 'Enemies spotted nearby!'),
    V: line('Vehicle', 'Incoming enemy vehicle!'),
    W: line('Watch it', 'Watch it!'),
  }),
  // Canon VU/VSU upgrade tree — kept for chord completeness even though
  // base assets don't have an upgrade mechanic yet; the lines read fine
  // as a request to whoever owns repairs.
  U: cat('Upgrade', {
    G: line('Generator', 'Upgrade our generator!'),
    S: line('Sensors', 'Upgrade our sensors!'),
    T: line('Turrets', 'Upgrade our base turrets!'),
  }),
  // Canon "VV" quick-response category — one-key answers under V V.
  // Team-scoped like canon: only the VG* family is all-chat.
  V: cat('Quick', {
    A: line('Any time'),
    B: line('Base secure?', 'Is our base secure?'),
    C: line('Cease fire', 'Cease fire!'),
    D: line("Don't know", "I don't know."),
    H: line('Help!', 'Help!'),
    M: line('Move!', 'Move!'),
    N: line('No'),
    S: line('Sorry'),
    T: line('Thanks'),
    W: line('Wait'),
    Y: line('Yes'),
  }),
  S: cat('Self', {
    A: cat('Attack', {
      A: line('Attack', 'I will attack.'),
      B: line('Base', 'I will attack the enemy base.'),
      F: line('Flag', 'I will get the enemy flag.'),
      G: line('Generator', 'I will destroy the enemy generator.'),
      S: line('Sensors', 'I will attack the enemy sensors.'),
      T: line('Turrets', 'I will destroy the enemy turrets.'),
      V: line('Vehicle', 'I will attack the enemy vehicle.'),
    }),
    D: cat('Defend', {
      D: line('Defend', 'I will defend.'),
      B: line('Base', 'I will defend our base.'),
      F: line('Flag', 'I will defend our flag.'),
      G: line('Generator', 'I will defend our generator.'),
      S: line('Sensors', 'I will defend our sensors.'),
      T: line('Turrets', 'I will defend our turrets.'),
      V: line('Vehicle', 'I will defend our vehicle.'),
    }),
    R: cat('Repair', {
      B: line('Base', 'I will repair our base.'),
      G: line('Generator', 'I will repair our generator.'),
      S: line('Sensors', 'I will repair our sensors.'),
      T: line('Turrets', 'I will repair our turrets.'),
      V: line('Vehicle', 'I will repair the vehicle.'),
    }),
    U: cat('Upgrade', {
      G: line('Generator', "I'll upgrade our generator."),
      S: line('Sensors', "I'll upgrade our sensors."),
      T: line('Turrets', "I'll upgrade our base turrets."),
    }),
    // Canon VST* task reports.
    T: cat('Task', {
      C: line('Cover you', "I'll cover you."),
      S: line('Set up defenses', "I'll set up defenses."),
      D: line('Forcefields', "I'm deploying forcefields."),
      O: line('On it', "I'm on it."),
      E: line('Sensors', "I'm deploying sensors."),
      T: line('Turrets', "I'm deploying turrets."),
      V: line('Vehicle', "I'll get a vehicle ready."),
    }),
    C: line('Cover me', 'Cover me!'),
    E: line('Enemy spotted', 'Enemy spotted!'),
    O: line('On my way', 'On my way.'),
  }),
};

