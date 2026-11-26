/**
 * Public "party game ideas" guides: keyword-focused landing pages for search (served at /party-games/[slug]).
 * Plain data so the page, the hub, the sitemap and the footer all read from one place.
 * Copy must stay true to the product: no claims about features that don't exist.
 */
export type GuideSection = { heading: string; paragraphs?: string[]; list?: string[] };
export type IdeaGroup = { name: string; items: string[] };
export type Guide = {
  slug: string;
  /** <title> (the layout adds " · BringMe!"), keep under ~50 characters. */
  metaTitle: string;
  /** Meta description / social card text, ~150 characters. */
  description: string;
  /** Visible page heading (H1). */
  title: string;
  /** Short label for links (footer, hub, related guides). */
  short: string;
  badge: string;
  mood: "happy" | "waiting" | "cheer" | "judging";
  intro: string;
  sections: GuideSection[];
  ideas: { heading: string; intro: string; groups: IdeaGroup[] };
  faq: { q: string; a: string }[];
  /** ISO date of the last content change (sitemap lastModified + "Updated" badge). */
  updated: string;
};

/** Answers that are the same on every guide (kept accurate to the product). */
const FAQ_NO_APP = {
  q: "Do players need to download an app or create an account?",
  a: "No. Players scan the QR code on the big screen (or type the room code at bringme.fun/play) and play in their phone's browser. No app, no sign-up, and it's always free for players.",
};
const FAQ_COST = {
  q: "How much does BringMe! cost?",
  a: "Playing is free. Hosts can start with a free 7-day trial for up to 3 players, and bigger games use a 7-Day Game Pass. See the pricing section on the homepage for current prices.",
};
const FAQ_SETUP = {
  q: "What do I need to host?",
  a: "A laptop to run the game, a screen everyone can see (a projector, a meeting-room display, or any smart TV using the TV link), and players with camera phones. Setting up rounds and items takes about a minute.",
};

const UPDATED = "2026-11-26";

export const GUIDES: Guide[] = [
  {
    slug: "bring-me-game",
    metaTitle: "Bring Me Game: Rules + 100+ Bring Me Ideas",
    description:
      "How to play the classic Bring Me party game, plus 100+ ready-to-shout Bring Me ideas for adults, offices, families and Christmas parties.",
    title: "The Bring Me game: rules and 100+ ideas",
    short: "Bring Me game ideas",
    badge: "Classic party game",
    mood: "cheer",
    intro:
      "One person shouts \"Bring me… a red pen!\" and everyone scrambles. The first to bring it wins the round. It's the simplest party game there is, and with the right list it works for any crowd.",
    sections: [
      {
        heading: "How to play the Bring Me game",
        paragraphs: [
          "The Bring Me game (also called a \"bring me\" scavenger hunt) needs one caller and at least two players or teams. The caller names an item, players race to find it nearby, and the first to bring it back scores a point.",
        ],
        list: [
          "Pick a caller and agree on a play area (the room, the office floor, the garden).",
          "The caller shouts \"Bring me…\" followed by an item from the list below.",
          "Players race to find it. No leaving the play area, no grabbing from other players.",
          "The first person (or team) to show the item wins the round and scores a point.",
          "Play 5 to 10 rounds. The highest score wins, and the winner becomes the next caller.",
        ],
      },
      {
        heading: "Tips for a great round",
        list: [
          "Mix easy items (a pen) with tricky ones (a coin from another country) so everyone gets a chance.",
          "Use teams for big groups: one runner per team keeps it fair and safe.",
          "Add a time limit of 30 to 60 seconds so rounds never drag.",
          "Save the funniest items (a selfie with the boss) for the final round.",
        ],
      },
      {
        heading: "Playing with a big group? Snap it instead of bringing it",
        paragraphs: [
          "With more than a handful of players, judging who arrived first gets chaotic. BringMe! turns the classic into a photo race: players join by scanning a QR code, the item appears on the big screen, and everyone snaps it on their phone. The host checks the photos on a laptop and crowns the winner live.",
        ],
      },
    ],
    ideas: {
      heading: "100+ Bring Me ideas",
      intro: "Copy these straight into your game. Everything here can be found at a typical party, office or home.",
      groups: [
        {
          name: "Easy starters",
          items: ["A red pen", "A coin", "A spoon", "Something blue", "A hair tie", "A receipt", "A sock", "A key", "A paper clip", "A bottle cap", "A tissue", "A sticky note", "A rubber band", "A shoelace", "Something green", "A button"],
        },
        {
          name: "Wallet, bag & pockets",
          items: ["A library or loyalty card", "A coin from another country", "A lip balm", "A train or bus ticket", "A photo of a pet", "Gum or a mint", "A hand sanitizer", "A receipt older than a month", "A band-aid", "A safety pin", "Sunglasses", "A business card"],
        },
        {
          name: "Phone & tech",
          items: ["A phone with less than 20% battery", "A charging cable", "Earbuds", "A phone case with a pattern", "A screenshot of a meme", "A photo taken before 2020", "An unread email count over 100", "A calculator app showing 1234", "A smartwatch", "A USB stick", "A selfie with three people", "Your oldest photo of food"],
        },
        {
          name: "Funny for adults",
          items: ["Something older than you", "The weirdest item in your bag", "A shoe that isn't yours", "A selfie making your best duck face", "Someone wearing two different socks", "A dad joke written on paper", "A photo of your most recent online order", "A human pyramid of three", "Someone who has never been to the beach", "Your best impression of a statue", "A compliment written on a napkin", "Someone born in December", "A matching outfit duo", "The best mustache drawn on a finger"],
        },
        {
          name: "Clothing & accessories",
          items: ["A striped shirt", "A watch", "Something with a logo", "A scarf", "A belt", "Glasses", "A ring", "Something with polka dots", "A hat", "Shoes with laces", "A jacket with a hood", "Something pink"],
        },
        {
          name: "Kitchen & breakroom",
          items: ["A mug with writing on it", "A tea bag", "A fork", "Something sweet", "A napkin", "A piece of fruit", "A bottle of water", "A sugar packet", "A straw", "A takeaway menu", "A paper cup", "Something spicy"],
        },
        {
          name: "Outdoors & garden",
          items: ["A leaf", "A smooth stone", "A flower", "A stick longer than your arm", "A pine cone", "Something yellow from nature", "A feather", "A blade of grass", "Something wet", "A shell", "Something perfectly round", "A heart-shaped stone"],
        },
        {
          name: "Kids & family",
          items: ["A toy car", "A crayon", "A stuffed animal", "A book with an animal on the cover", "A ball", "A sticker", "A LEGO brick", "Something soft", "A puzzle piece", "A spoon and a fork", "Something that makes noise", "A drawing of a cat"],
        },
      ],
    },
    faq: [
      {
        q: "What is the Bring Me game?",
        a: "A fast party game where a caller shouts \"Bring me…\" and an item, and players race to bring it first. The first to bring it scores a point, and the most points after several rounds wins.",
      },
      {
        q: "How many people do you need?",
        a: "At least three: one caller and two players. It scales to big groups by playing in teams, or by switching to a photo version where everyone snaps the item on their phone.",
      },
      {
        q: "What are good Bring Me ideas for adults?",
        a: "Mix everyday items (a receipt, a coin from another country) with funny ones (a shoe that isn't yours, someone born in December). The \"Funny for adults\" list above has a dozen ready to use.",
      },
      FAQ_NO_APP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
  {
    slug: "christmas-office-party-game",
    metaTitle: "Christmas Office Party Game for Any Team",
    description:
      "A Christmas office party game the whole team will actually play: set up in a minute, join by QR code, race to snap festive items. Plus 50 holiday ideas.",
    title: "A Christmas office party game everyone actually plays",
    short: "Christmas party game",
    badge: "Holiday party idea",
    mood: "cheer",
    intro:
      "Secret Santa is done, the snacks are out, and half the room is on their phones. Put those phones to work: shout a festive item, and watch the whole office race to snap it first.",
    sections: [
      {
        heading: "Why most Christmas party games fall flat",
        paragraphs: [
          "Quizzes reward the same three trivia fans. Charades makes the quiet half of the team want to hide. A good office Christmas game is quick to explain, lets everyone play at once, and is over before anyone checks the time.",
        ],
      },
      {
        heading: "How to run it in 3 steps",
        list: [
          "Before the party: create a game on your laptop and add a few rounds of festive items (use the list below).",
          "At the party: put the game on the projector or TV. Everyone scans the QR code with their phone and types a name.",
          "Play: reveal an item, everyone races to find it and snap a photo. You check the photos and crown each round's winner on the big screen.",
        ],
      },
      {
        heading: "Make it extra festive",
        list: [
          "Play in teams by department for some friendly rivalry.",
          "Give the overall winner a prize: first pick from the Secret Santa pile, or the last mince pie.",
          "Finish with a round of photo bingo with a Christmas card of items.",
          "Keep rounds short (30 to 60 seconds) so the energy stays high.",
        ],
      },
    ],
    ideas: {
      heading: "50 Christmas items to shout",
      intro: "Festive, office-friendly, and findable at almost any holiday party.",
      groups: [
        {
          name: "Decorations",
          items: ["A bauble", "Tinsel", "Fairy lights", "A Christmas card", "Something with a snowflake", "A candy cane", "A star", "Something gold", "A ribbon", "Wrapping paper", "A gift tag", "A bow", "A snow globe"],
        },
        {
          name: "Festive people",
          items: ["Someone in a Christmas jumper", "Someone wearing a Santa hat", "A selfie with the party host", "Two people doing a festive pose", "Someone wearing red and green", "Your best reindeer impression", "A group of five singing", "Someone who has already finished their shopping", "The person who travelled furthest home last year", "A colleague you've never had lunch with", "Someone who loves Christmas music", "A team photo in front of the tree"],
        },
        {
          name: "Food & drink",
          items: ["A mince pie", "Something with cinnamon", "A chocolate", "A festive mug", "A cracker", "A paper crown", "Something peppermint", "A gingerbread person", "A napkin with a pattern", "A clementine", "Something sparkly to drink", "A cookie"],
        },
        {
          name: "Around the office",
          items: ["A Secret Santa gift", "Something wrapped", "A calendar showing December", "Something white like snow", "A plant", "Something that jingles", "A sticky note with a holiday wish", "A pen with festive colours", "A New Year's resolution written down", "Something you'd re-gift", "The tallest thing on your desk", "Something cozy", "A photo of snow"],
        },
      ],
    },
    faq: [
      {
        q: "What's a good Christmas party game for a big office?",
        a: "One where everyone plays at the same time on their own phone. In BringMe! the whole room races to snap the item shown on the big screen, so nobody waits on the sidelines.",
      },
      {
        q: "How long does a game take?",
        a: "You choose. A handful of rounds fits in 10 to 15 minutes, which is ideal between dinner and the speeches.",
      },
      FAQ_SETUP,
      FAQ_NO_APP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
  {
    slug: "team-building-game",
    metaTitle: "Quick Team Building Game With Zero Prep",
    description:
      "A quick team building game that gets the whole team moving and laughing in 15 minutes. No prep, no props: players join on their phones by QR code.",
    title: "A quick team building game that gets everyone moving",
    short: "Team building game",
    badge: "Team building",
    mood: "happy",
    intro:
      "The best team building activities don't feel like team building. A short, noisy race to find things around the office breaks the ice faster than any trust fall.",
    sections: [
      {
        heading: "What makes a team building game work",
        list: [
          "Everyone plays at once: no audience, no spotlight on one person.",
          "It's short: 10 to 20 minutes, so it fits in a meeting, offsite or kickoff.",
          "It needs no skill: finding a stapler is fair for interns and directors alike.",
          "It creates stories: the photos and near-misses are what people talk about afterwards.",
        ],
      },
      {
        heading: "How to run it",
        list: [
          "Create a game on your laptop and add rounds of items (ideas below). Mix solo and team items.",
          "Open presenter mode on the meeting-room screen. The team scans the QR code to join.",
          "Reveal an item. Everyone races to find it and snap it on their phone.",
          "Check the photos on your laptop, crown each round's winner, and reveal the final results.",
        ],
      },
      {
        heading: "Turn it into real team building",
        paragraphs: [
          "Add items that make people talk to each other: \"a selfie with someone from another team\", \"something that shows your hobby\", \"the oldest thing on your desk and the story behind it\". After the game, put a few of the best photos up and ask the winners to tell their story.",
        ],
      },
    ],
    ideas: {
      heading: "Team building item ideas",
      intro: "A mix of quick finds and items that get people talking.",
      groups: [
        {
          name: "Get people talking",
          items: ["A selfie with someone from another team", "Someone who started this year", "Something that shows your hobby", "A photo of your workspace mascot", "Two people with the same birthday month", "Someone who speaks three languages", "A group of four with no two from the same team", "Your favourite mug and its story", "Someone who has a pet with a funny name", "A high five with your manager"],
        },
        {
          name: "Around the office",
          items: ["A stapler", "A whiteboard marker that still works", "A company-branded item", "A plant", "A notebook with handwriting", "Something from the kitchen", "The oldest thing on your desk", "A charger that isn't yours", "Something from a past team event", "A coloured folder", "A badge or lanyard", "A photo of today's lunch"],
        },
        {
          name: "Creative challenges",
          items: ["Spell your team name with your bodies", "Recreate a famous painting", "A human pyramid (safely!)", "The company logo drawn on paper", "Your team's best superhero pose", "Something that represents this quarter", "A slogan for the next offsite", "The calmest person in the office"],
        },
      ],
    },
    faq: [
      {
        q: "Can we play in teams?",
        a: "Yes. Group players by table or department and have each team send in its best photo, or let everyone play solo and add up scores by team.",
      },
      {
        q: "Does it work for a town hall or all-hands?",
        a: "Yes. Players only need the QR code on the big screen, so a large room can join in seconds. See our guide to icebreakers for large groups.",
      },
      FAQ_SETUP,
      FAQ_NO_APP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
  {
    slug: "photo-scavenger-hunt",
    metaTitle: "Photo Scavenger Hunt: Ideas & How to Run It",
    description:
      "Photo scavenger hunt ideas for adults, teams and parties, plus how to run one live: players join by QR code and race to snap each item first.",
    title: "Photo scavenger hunt ideas (and how to run one live)",
    short: "Photo scavenger hunt",
    badge: "Scavenger hunt",
    mood: "judging",
    intro:
      "A photo scavenger hunt keeps the fun of a classic hunt without anyone carrying armfuls of stuff around. Players find the item, snap it, and move on, and you get a gallery of the best moments.",
    sections: [
      {
        heading: "Two ways to run a photo scavenger hunt",
        paragraphs: [
          "The classic way: hand out a list, give everyone an hour, and compare photos at the end. Great for outdoor events and long afternoons.",
          "The live way: reveal one item at a time on a big screen and let everyone race to snap it. Each round takes about a minute, there's a winner every round, and the whole room watches the results together. That's how BringMe! works.",
        ],
      },
      {
        heading: "How to run a live photo scavenger hunt",
        list: [
          "Create a game on your laptop and add one item per round.",
          "Put the game on a projector or TV. Players scan the QR code and enter a name.",
          "Reveal an item. Players race to find it and snap it on their phone.",
          "Check the submitted photos, crown the round winner, and move to the next item.",
        ],
      },
      {
        heading: "Prefer a checklist? Try photo bingo",
        paragraphs: [
          "If you want everyone hunting at their own pace, give them a bingo card of things to find instead. Players snap a full line (or the whole card) and call Bingo. See our photo bingo guide for card ideas.",
        ],
      },
    ],
    ideas: {
      heading: "Photo scavenger hunt ideas",
      intro: "Grouped by setting. Pick 5 to 10 per game.",
      groups: [
        {
          name: "For adults",
          items: ["A stranger's dog (ask first!)", "Something older than everyone in your team", "A reflection of yourself", "A sign with a spelling mistake", "Your team jumping in the air", "Something shaped like a letter of your name", "A photo that looks like an album cover", "Something that costs exactly one coin", "The best view nearby", "A team photo where nobody shows their face"],
        },
        {
          name: "At the office",
          items: ["The messiest desk (with permission)", "A motivational poster", "A whiteboard doodle", "Someone mid-laugh", "A chair that spins", "The fire exit sign", "A view from the highest window", "Something in the company colours", "A meeting room with a funny name", "A coffee art attempt"],
        },
        {
          name: "Outdoors",
          items: ["A bird", "A red door", "A bench with a plaque", "A puddle reflection", "A tree you can't wrap your arms around", "A street art mural", "A bicycle", "A cloud with a shape", "Something that starts with the letter B", "A sign with a number over 100"],
        },
        {
          name: "At a party",
          items: ["The host", "The best-dressed guest", "A group selfie of six", "Someone dancing", "The snack table", "A balloon", "Someone wearing a hat", "A toast in progress", "The most colourful drink", "Two strangers who just met"],
        },
      ],
    },
    faq: [
      {
        q: "How do you judge a photo scavenger hunt?",
        a: "In a live game the host reviews the submitted photos and picks the winner of each round. In BringMe! that happens on the host's laptop, and the winner appears on the big screen.",
      },
      {
        q: "How many items should a photo scavenger hunt have?",
        a: "For a live game, 5 to 10 rounds is the sweet spot (10 to 20 minutes). For a self-paced hunt, 15 to 25 items over an hour.",
      },
      FAQ_NO_APP,
      FAQ_SETUP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
  {
    slug: "icebreaker-games-for-large-groups",
    metaTitle: "Icebreaker Game for Large Groups & Town Halls",
    description:
      "An icebreaker game for large groups, town halls and all-hands meetings: everyone joins by QR code in seconds and plays at once on their phone.",
    title: "An icebreaker game for large groups and town halls",
    short: "Icebreakers for large groups",
    badge: "Icebreaker",
    mood: "waiting",
    intro:
      "Most icebreakers fall apart past 20 people: introductions take forever and only the front row joins in. A big-screen game that everyone plays on their own phone flips that around.",
    sections: [
      {
        heading: "What large-group icebreakers need",
        list: [
          "Instant joining: a QR code on the screen beats handing out links or codes one by one.",
          "Everyone plays at once, so nobody waits for their turn.",
          "Something to watch together: results on the big screen give the room a shared moment.",
          "A hard stop: it should fit into 10 minutes of the agenda.",
        ],
      },
      {
        heading: "How to open your town hall with it",
        list: [
          "Before the meeting, create a game with 3 to 5 rounds.",
          "Open presenter mode on the main screen as people arrive. The QR code is right there, so people join while they find a seat.",
          "Run a few quick rounds of things everyone has with them: a pen, something blue, a photo of their pet.",
          "Show the final winners, then move into the agenda with the room already awake.",
        ],
      },
      {
        heading: "Keep it inclusive",
        list: [
          "Pick items people can find without leaving their seat for the first round.",
          "Avoid items that depend on money, age or physical ability.",
          "Celebrate funny photos, not just the fastest ones.",
        ],
      },
    ],
    ideas: {
      heading: "Icebreaker items anyone can find",
      intro: "Chosen so people can play from their seat or nearby.",
      groups: [
        {
          name: "From your seat",
          items: ["A pen", "Something blue", "Your phone's lock screen", "A photo of your pet", "The last photo you took", "Your favourite emoji, drawn on paper", "Something with a logo", "Your coffee or tea", "A thumbs up from your neighbour", "Your best smile"],
        },
        {
          name: "Get to know each other",
          items: ["A selfie with someone you've never met", "Someone who joined this month", "Someone from a different city", "A photo from your last holiday", "Your hidden talent, in one photo", "Your desk view", "Someone with the same first initial", "A group of three from different teams"],
        },
      ],
    },
    faq: [
      {
        q: "How quickly can a large group join?",
        a: "As fast as people can point their camera at the QR code. There's no app to install and no account to create.",
      },
      {
        q: "Do I need a special screen?",
        a: "No. Any projector or meeting-room display works with presenter mode, and a smart TV can open the game through a TV link without signing in.",
      },
      FAQ_NO_APP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
  {
    slug: "photo-bingo",
    metaTitle: "Photo Bingo: How to Play + Card Ideas",
    description:
      "How to play photo bingo at work or a party: 3×3, 4×4 or 5×5 cards of things to find and snap. Free photo bingo ideas, no printing needed.",
    title: "Photo bingo: how to play, plus card ideas",
    short: "Photo bingo",
    badge: "Bingo with a camera",
    mood: "happy",
    intro:
      "Photo bingo swaps numbered balls for things to find. Everyone gets a card of items, snaps them one by one, and shouts Bingo when a line is complete. No printing, no pens, no dabbers.",
    sections: [
      {
        heading: "How photo bingo works",
        list: [
          "The host builds a card of items to find: 3×3 for a quick game, 5×5 for a long one.",
          "Players join on their phones. Everyone gets the same items, each in their own order.",
          "Players snap each item they find to mark the square.",
          "Complete a line (Traditional Bingo) or the whole card (Full Card Challenge) and call Bingo.",
          "The host checks the Bingo in person and crowns the winner.",
        ],
      },
      {
        heading: "Photo bingo vs. a photo scavenger hunt",
        paragraphs: [
          "A scavenger hunt is a race for one item at a time. Photo bingo lets everyone hunt at their own pace, which makes it great for mingling at a party or running in the background of an event.",
          "In BingoSnap (the photo bingo game in BringMe!), photos stay on players' own phones and the host checks every Bingo in person.",
        ],
      },
    ],
    ideas: {
      heading: "Photo bingo card ideas",
      intro: "Pick 9, 16 or 25 items for your card.",
      groups: [
        {
          name: "Office bingo",
          items: ["A plant", "A stapler", "Someone on a call", "A whiteboard drawing", "A coffee mug with a slogan", "A sticky note", "A colleague wearing glasses", "A laptop sticker", "A water bottle", "Someone laughing", "A printer", "A calendar", "A window view", "A lanyard", "A snack", "A notebook"],
        },
        {
          name: "Party bingo",
          items: ["A balloon", "Someone dancing", "A group selfie", "A birthday card", "Someone in a hat", "A cake", "A toast", "Fairy lights", "A pet", "A board game", "Someone wearing stripes", "Sunglasses indoors", "A gift", "A candle", "Someone singing", "A paper plate"],
        },
        {
          name: "Holiday bingo",
          items: ["A Christmas tree", "Tinsel", "A Santa hat", "A gingerbread person", "A wrapped gift", "A candy cane", "A snowflake", "A festive jumper", "A reindeer", "A star", "A wreath", "A cracker", "Hot chocolate", "A bauble", "A stocking", "Mistletoe"],
        },
      ],
    },
    faq: [
      {
        q: "What sizes can a photo bingo card be?",
        a: "3×3, 4×4 or 5×5. Smaller cards suit a quick 10-minute game, and a 5×5 Full Card Challenge can run all evening.",
      },
      {
        q: "Who checks that a Bingo is real?",
        a: "The host. In BingoSnap, photos stay on the player's phone, so the player shows their card and the host confirms the Bingo in person.",
      },
      FAQ_NO_APP,
      FAQ_COST,
    ],
    updated: UPDATED,
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export const guidePath = (slug: string) => `/party-games/${slug}`;
