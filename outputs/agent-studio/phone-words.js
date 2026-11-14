'use strict';
/* The pairing word list: 256 short words, one per byte. The PC shows a pairing code as six of them (the 6-byte
   one-time secret in the QR), and both sides show two check words. server/remote/words.ts has the same list
   (work/deno/remote_pairing_test.ts keeps the two equal). Classic script: the phone page reads window.AIBPhoneWords. */
(function (root) {
  const WORDS = [
    'amber', 'anchor', 'apple', 'april', 'arrow', 'atlas', 'autumn', 'badge', 'bakery', 'bamboo',
    'banjo', 'barrel', 'basket', 'beacon', 'berry', 'bison', 'blanket', 'blossom', 'bottle', 'breeze',
    'bridge', 'bronze', 'bubble', 'bucket', 'butter', 'cabin', 'cactus', 'camera', 'candle', 'canyon',
    'carbon', 'carpet', 'castle', 'cedar', 'cherry', 'chess', 'cider', 'circle', 'clover', 'cobalt',
    'coffee', 'comet', 'copper', 'coral', 'cotton', 'cradle', 'crayon', 'cricket', 'crystal', 'dancer',
    'delta', 'desert', 'dinner', 'dolphin', 'dragon', 'drum', 'eagle', 'echo', 'elbow', 'ember',
    'engine', 'falcon', 'feather', 'fern', 'fiddle', 'field', 'flame', 'forest', 'fossil', 'fox',
    'galaxy', 'garden', 'garlic', 'ginger', 'glacier', 'globe', 'goblet', 'granite', 'gravel', 'guitar',
    'hammer', 'harbor', 'harvest', 'hazel', 'helmet', 'hermit', 'honey', 'hornet', 'igloo', 'indigo',
    'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jelly', 'jigsaw', 'jungle', 'kayak', 'kernel',
    'kettle', 'kitten', 'koala', 'ladder', 'lagoon', 'lantern', 'laptop', 'lemon', 'lily', 'linen',
    'lizard', 'lobster', 'locket', 'lotus', 'lunar', 'magnet', 'mango', 'maple', 'marble', 'meadow',
    'melon', 'meteor', 'mirror', 'mitten', 'monkey', 'mosaic', 'mustard', 'nectar', 'needle', 'nickel',
    'nine', 'noodle', 'nutmeg', 'oasis', 'ocean', 'olive', 'onion', 'opal', 'orbit', 'orchid',
    'otter', 'oyster', 'paddle', 'panda', 'paper', 'parrot', 'pebble', 'pepper', 'piano', 'pickle',
    'pigeon', 'pillow', 'pilot', 'planet', 'plum', 'pocket', 'polar', 'pony', 'poppy', 'potato',
    'prism', 'pumpkin', 'puzzle', 'quartz', 'quill', 'rabbit', 'radar', 'radish', 'raven', 'ribbon',
    'river', 'robin', 'rocket', 'ruby', 'saddle', 'salmon', 'satin', 'scarf', 'shadow', 'shell',
    'silver', 'sketch', 'sled', 'slipper', 'socket', 'sofa', 'spider', 'spoon', 'spruce', 'squid',
    'stamp', 'star', 'stone', 'storm', 'sugar', 'summer', 'sunset', 'swan', 'tablet', 'tango',
    'teapot', 'tennis', 'thistle', 'thunder', 'tiger', 'timber', 'toast', 'tomato', 'topaz', 'torch',
    'tractor', 'tulip', 'tundra', 'turtle', 'umbrella', 'valley', 'velvet', 'violet', 'violin', 'volcano',
    'wagon', 'walnut', 'walrus', 'waffle', 'wheat', 'whistle', 'willow', 'window', 'winter', 'wizard',
    'wolf', 'yarn', 'yogurt', 'zebra', 'zipper', 'acorn', 'badger', 'beaver', 'canoe', 'cloud',
    'daisy', 'dune', 'easel', 'fable', 'fig', 'frost', 'geyser', 'hawk', 'iris', 'jade',
    'kiwi', 'lark', 'lime', 'moss', 'nest', 'oak',
  ];
  root.AIBPhoneWords = WORDS;
  if (typeof module === 'object' && module.exports) module.exports = WORDS;
})(typeof window !== 'undefined' ? window : globalThis);
