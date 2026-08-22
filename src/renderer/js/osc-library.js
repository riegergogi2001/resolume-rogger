// Resolume Arena 7 OSC command library.
//
// Resolume does not ship a machine-readable OSC map; instead its OSC surface
// mirrors the parameter tree exposed by the bundled REST API
// (`/Applications/Resolume Arena/rest/docs/swagger.yaml`), one path segment
// per nested property. This file is a curated, flattened index of that tree,
// rewritten as OSC address templates.
//
// Naming rules Resolume applies when turning a REST/UI parameter name into
// an OSC path segment:
//   - the segment is lower-cased and all spaces are stripped
//     ("Blend Mode" -> "blendmode", "Ignore Column Trigger" -> "ignorecolumntrigger")
//   - underscores are stripped the same way ("tempo_tap" -> "tempotap",
//     "play_state" -> "playstate"); confirmed for tempotap/resync via the
//     addresses already used in configs/campus-forum-stage.json, the rest
//     (playstate, durationtype, loopcount, randomtype, blendmode) follow the
//     same convention but are not independently OSC-verified here
//   - when an effect (or a duplicate audio/video track) appears more than
//     once in the same chain, Resolume appends a 1-based instance number to
//     the *effect* segment: "pusher", "pusher2", "pusher3", ...
//   - EventParameter (trigger-only) parameters keep a trailing "!" in their
//     name, e.g. Pusher's "push!" -> effect/push! ; send 1 to fire it
//   - RangeParameter values (opacity, master, most effect sliders, tempo,
//     crossfader phase, ...) always arrive/leave over OSC normalized to
//     0..1, regardless of the min/max shown in the Resolume UI. Composition
//     tempo is the one with a commonly quoted mapping: bpm = 20 + v*480
//
// Placeholders (only these appear in LIBRARY addresses):
//   {L}  layer index        {C}  clip index (within a layer)
//   {N}  column index       {G}  layer group index (OSC calls these
//                                 "groups"; the REST API calls the same
//                                 object "layergroups" - both refer to the
//                                 same tree, OSC just uses the shorter name)
//   {D}  deck index         {FX} effect name, lower-cased/space-stripped,
//                                 numbered on duplicates (pusher2, ...)
//   {P}  effect parameter name, lower-cased/space-stripped, keeps "!" for
//        event params (push!)
//   {K}  dashboard quick-link slot, 1-8
//
// `kind` classifies how a value should be sent:
//   event  - trigger; send int 1 (release/off = 0 where applicable)
//   float  - RangeParameter, 0..1 normalized
//   int    - IntegerParameter, unbounded whole number
//   bool   - BooleanParameter, 0 or 1
//   choice - ChoiceParameter/state; send the integer option index
//   string - StringParameter/TextParameter; send text
export const LIBRARY = [
  // ---------------------------------------------------------------- Composition
  { group: 'Composition', label: 'Composition name', address: '/composition/name', kind: 'string' },
  { group: 'Composition', label: 'Composition bypassed', address: '/composition/bypassed', kind: 'bool', values: [0, 1], hint: 'bypasses the entire composition output' },
  { group: 'Composition', label: 'Master level', address: '/composition/master', kind: 'float', float: true, hint: 'overall composition output level, 0..1' },
  { group: 'Composition', label: 'Speed', address: '/composition/speed', kind: 'float', float: true, hint: 'global composition playback speed multiplier, normalized' },
  { group: 'Composition', label: 'Clip target', address: '/composition/cliptarget', kind: 'choice', hint: 'default trigger target used when a clip is clicked (option index)' },
  { group: 'Composition', label: 'Clip trigger style', address: '/composition/cliptriggerstyle', kind: 'choice', hint: 'default trigger style for new clip triggers (option index)' },
  { group: 'Composition', label: 'Clip beat snap', address: '/composition/clipbeatsnap', kind: 'choice', hint: 'default beat-snap resolution for new clip triggers (option index)' },
  { group: 'Composition', label: 'Disconnect all', address: '/composition/disconnectall', kind: 'event', values: [1], hint: 'stops every connected clip/column across the whole composition' },

  // ---------------------------------------------------------------- Tempo
  { group: 'Tempo', label: 'Tempo (BPM)', address: '/composition/tempocontroller/tempo', kind: 'float', float: true, hint: 'tempo arrives normalized: bpm = 20 + v*480' },
  { group: 'Tempo', label: 'Tempo tap', address: '/composition/tempocontroller/tempotap', kind: 'event', values: [1], hint: 'tap repeatedly on the beat to set BPM' },
  { group: 'Tempo', label: 'Resync', address: '/composition/tempocontroller/resync', kind: 'event', values: [1], hint: 'realigns all BPM-synced content back to beat 1' },
  { group: 'Tempo', label: 'Tempo pull', address: '/composition/tempocontroller/tempopull', kind: 'event', values: [1], hint: 'nudges tempo down while held' },
  { group: 'Tempo', label: 'Tempo push', address: '/composition/tempocontroller/tempopush', kind: 'event', values: [1], hint: 'nudges tempo up while held' },
  { group: 'Tempo', label: 'Play state', address: '/composition/tempocontroller/playstate', kind: 'choice', hint: 'transport play/pause state of the tempo controller' },

  // ---------------------------------------------------------------- Crossfader
  { group: 'Crossfader', label: 'Crossfader phase', address: '/composition/crossfader/phase', kind: 'float', float: true, hint: '0 = fully side A, 1 = fully side B' },
  { group: 'Crossfader', label: 'Crossfader behaviour', address: '/composition/crossfader/behaviour', kind: 'choice', hint: 'how layers are assigned to side A/B (option index)' },
  { group: 'Crossfader', label: 'Crossfader curve', address: '/composition/crossfader/curve', kind: 'choice', hint: 'fade curve shape between the two sides (option index)' },
  { group: 'Crossfader', label: 'Crossfader side A', address: '/composition/crossfader/sidea', kind: 'event', values: [1], hint: 'snaps the crossfader fully to side A' },
  { group: 'Crossfader', label: 'Crossfader side B', address: '/composition/crossfader/sideb', kind: 'event', values: [1], hint: 'snaps the crossfader fully to side B' },
  { group: 'Crossfader', label: 'Crossfader mixer blend mode', address: '/composition/crossfader/mixer/blendmode', kind: 'choice', hint: 'crossfader.mixer is an open parameter collection; blendmode is the well-known key' },

  // ---------------------------------------------------------------- Decks
  { group: 'Decks', label: 'Deck select', address: '/composition/decks/{D}/select', kind: 'event', values: [1], hint: 'switches the active deck (layers/clips) to {D}' },
  { group: 'Decks', label: 'Deck name', address: '/composition/decks/{D}/name', kind: 'string' },
  { group: 'Decks', label: 'Deck color', address: '/composition/decks/{D}/colorid', kind: 'choice' },
  { group: 'Decks', label: 'Deck open', address: '/composition/decks/{D}/open', kind: 'event', values: [1], hint: 'opens a closed deck' },
  { group: 'Decks', label: 'Deck close', address: '/composition/decks/{D}/close', kind: 'event', values: [1], hint: 'closes the deck, freeing its layers/clips from memory' },
  { group: 'Decks', label: 'Deck scroll position', address: '/composition/decks/{D}/scrollx', kind: 'int', hint: 'horizontal scroll offset of the deck in the composition view' },

  // ---------------------------------------------------------------- Columns
  { group: 'Columns', label: 'Column connect', address: '/composition/columns/{N}/connect', kind: 'event', values: [1], hint: 'triggers every clip in column {N} across all layers' },
  { group: 'Columns', label: 'Column select', address: '/composition/columns/{N}/select', kind: 'event', values: [1] },
  { group: 'Columns', label: 'Column name', address: '/composition/columns/{N}/name', kind: 'string' },
  { group: 'Columns', label: 'Column color', address: '/composition/columns/{N}/colorid', kind: 'choice' },
  { group: 'Columns', label: 'Column beat snap', address: '/composition/columns/{N}/beatsnap', kind: 'choice' },
  { group: 'Columns', label: 'Column clip connected', address: '/composition/columns/{N}/clipconnected', kind: 'bool', hint: 'read-only: 1 while any clip in this column is connected' },

  // ---------------------------------------------------------------- Layer groups
  // OSC canonical prefix is "groups" (the REST API names the same object "layergroups").
  { group: 'Layer groups', label: 'Group name', address: '/composition/groups/{G}/name', kind: 'string' },
  { group: 'Layer groups', label: 'Group select', address: '/composition/groups/{G}/select', kind: 'event', values: [1] },
  { group: 'Layer groups', label: 'Group clear', address: '/composition/groups/{G}/clear', kind: 'event', values: [1], hint: 'disconnects every clip inside the group' },
  { group: 'Layer groups', label: 'Group color', address: '/composition/groups/{G}/colorid', kind: 'choice' },
  { group: 'Layer groups', label: 'Group bypassed', address: '/composition/groups/{G}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Layer groups', label: 'Group solo', address: '/composition/groups/{G}/solo', kind: 'bool', values: [0, 1] },
  { group: 'Layer groups', label: 'Group crossfader assign', address: '/composition/groups/{G}/crossfadergroup', kind: 'choice', hint: 'assigns the group to crossfader side A/B/none (option index)' },
  { group: 'Layer groups', label: 'Group master', address: '/composition/groups/{G}/master', kind: 'float', float: true },
  { group: 'Layer groups', label: 'Group speed', address: '/composition/groups/{G}/speed', kind: 'float', float: true },
  { group: 'Layer groups', label: 'Group ignore column trigger', address: '/composition/groups/{G}/ignorecolumntrigger', kind: 'bool', values: [0, 1] },
  { group: 'Layer groups', label: 'Group column connect', address: '/composition/groups/{G}/columns/{N}/connect', kind: 'event', values: [1], hint: 'triggers column {N}, but only for layers that belong to group {G}' },
  { group: 'Layer groups', label: 'Group column select', address: '/composition/groups/{G}/columns/{N}/select', kind: 'event', values: [1] },
  { group: 'Layer groups', label: 'Group video opacity', address: '/composition/groups/{G}/video/opacity', kind: 'float', float: true },
  { group: 'Layer groups', label: 'Group video mixer blend mode', address: '/composition/groups/{G}/video/mixer/blendmode', kind: 'choice' },

  // ---------------------------------------------------------------- Layer
  { group: 'Layer', label: 'Layer name', address: '/composition/layers/{L}/name', kind: 'string' },
  { group: 'Layer', label: 'Layer select', address: '/composition/layers/{L}/select', kind: 'event', values: [1] },
  { group: 'Layer', label: 'Layer clear', address: '/composition/layers/{L}/clear', kind: 'event', values: [1], hint: 'disconnects the active clip on this layer' },
  { group: 'Layer', label: 'Layer clear all clips', address: '/composition/layers/{L}/clearclips', kind: 'event', values: [1], hint: 'empties every clip slot on the layer, not just the active one' },
  { group: 'Layer', label: 'Layer color', address: '/composition/layers/{L}/colorid', kind: 'choice' },
  { group: 'Layer', label: 'Layer bypassed', address: '/composition/layers/{L}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Layer', label: 'Layer solo', address: '/composition/layers/{L}/solo', kind: 'bool', values: [0, 1] },
  { group: 'Layer', label: 'Layer crossfader assign', address: '/composition/layers/{L}/crossfadergroup', kind: 'choice' },
  { group: 'Layer', label: 'Layer master', address: '/composition/layers/{L}/master', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer mask mode', address: '/composition/layers/{L}/maskmode', kind: 'choice' },
  { group: 'Layer', label: 'Layer ignore column trigger', address: '/composition/layers/{L}/ignorecolumntrigger', kind: 'bool', values: [0, 1] },
  { group: 'Layer', label: 'Layer fader start', address: '/composition/layers/{L}/faderstart', kind: 'bool', values: [0, 1], hint: 'when on, raising the layer fader from 0 also triggers the selected clip' },
  { group: 'Layer', label: 'Layer autopilot target', address: '/composition/layers/{L}/autopilot/target', kind: 'choice', hint: 'which autopilot behaviour drives clip changes on this layer (option index; the AUTO VJ template uses 3)' },
  { group: 'Layer', label: 'Layer autopilot duration type', address: '/composition/layers/{L}/autopilot/durationtype', kind: 'choice' },
  { group: 'Layer', label: 'Layer autopilot beats', address: '/composition/layers/{L}/autopilot/beats', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer autopilot seconds', address: '/composition/layers/{L}/autopilot/seconds', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer autopilot loop count', address: '/composition/layers/{L}/autopilot/loopcount', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer autopilot random type', address: '/composition/layers/{L}/autopilot/randomtype', kind: 'choice' },
  { group: 'Layer', label: 'Layer autopilot loop', address: '/composition/layers/{L}/autopilot/loop', kind: 'bool', values: [0, 1] },
  { group: 'Layer', label: 'Layer video opacity', address: '/composition/layers/{L}/video/opacity', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer video mixer blend mode', address: '/composition/layers/{L}/video/mixer/blendmode', kind: 'choice' },
  { group: 'Layer', label: 'Layer video autosize', address: '/composition/layers/{L}/video/autosize', kind: 'choice' },
  { group: 'Layer', label: 'Layer transition duration', address: '/composition/layers/{L}/transition/duration', kind: 'float', float: true },
  { group: 'Layer', label: 'Layer transition blend mode', address: '/composition/layers/{L}/transition/blendmode', kind: 'choice', hint: 'transition Resolume plays between the outgoing and incoming clip on this layer' },

  // ---------------------------------------------------------------- Layer FX
  // Covers both per-layer and per-group video/audio effect chains - both
  // shapes are identical in swagger, just rooted at layers/{L} or groups/{G}.
  { group: 'Layer FX', label: 'Layer FX opacity', address: '/composition/layers/{L}/video/effects/{FX}/opacity', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Layer FX bypassed', address: '/composition/layers/{L}/video/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Layer FX', label: 'Layer FX mixer blend mode', address: '/composition/layers/{L}/video/effects/{FX}/mixer/blendmode', kind: 'choice' },
  { group: 'Layer FX', label: 'Layer FX parameter', address: '/composition/layers/{L}/video/effects/{FX}/effect/{P}', kind: 'float', float: true, hint: 'generic effect parameter; trigger params ending in ! (e.g. push!) are events, send 1' },
  { group: 'Layer FX', label: 'Layer FX color red', address: '/composition/layers/{L}/video/effects/{FX}/effect/color/red', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Layer FX color green', address: '/composition/layers/{L}/video/effects/{FX}/effect/color/green', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Layer FX color blue', address: '/composition/layers/{L}/video/effects/{FX}/effect/color/blue', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Layer audio FX bypassed', address: '/composition/layers/{L}/audio/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Layer FX', label: 'Group FX opacity', address: '/composition/groups/{G}/video/effects/{FX}/opacity', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Group FX bypassed', address: '/composition/groups/{G}/video/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Layer FX', label: 'Group FX mixer blend mode', address: '/composition/groups/{G}/video/effects/{FX}/mixer/blendmode', kind: 'choice' },
  { group: 'Layer FX', label: 'Group FX parameter', address: '/composition/groups/{G}/video/effects/{FX}/effect/{P}', kind: 'float', float: true, hint: 'e.g. .../colorize/effect/greyskeep or .../huerotate/effect/huerotate' },
  { group: 'Layer FX', label: 'Group FX color red', address: '/composition/groups/{G}/video/effects/{FX}/effect/color/red', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Group FX color green', address: '/composition/groups/{G}/video/effects/{FX}/effect/color/green', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Group FX color blue', address: '/composition/groups/{G}/video/effects/{FX}/effect/color/blue', kind: 'float', float: true },
  { group: 'Layer FX', label: 'Group audio FX bypassed', address: '/composition/groups/{G}/audio/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },

  // ---------------------------------------------------------------- Clip
  { group: 'Clip', label: 'Clip connect', address: '/composition/layers/{L}/clips/{C}/connect', kind: 'event', values: [1], hint: 'triggers this clip; send 0 to disconnect' },
  { group: 'Clip', label: 'Clip select', address: '/composition/layers/{L}/clips/{C}/select', kind: 'event', values: [1] },
  { group: 'Clip', label: 'Clip clear', address: '/composition/layers/{L}/clips/{C}/clear', kind: 'event', values: [1], hint: 'empties the clip slot entirely, removing the loaded media' },
  { group: 'Clip', label: 'Clip name', address: '/composition/layers/{L}/clips/{C}/name', kind: 'string' },
  { group: 'Clip', label: 'Clip color', address: '/composition/layers/{L}/clips/{C}/colorid', kind: 'choice' },
  { group: 'Clip', label: 'Clip target', address: '/composition/layers/{L}/clips/{C}/target', kind: 'choice', hint: 'which target list entry this clip triggers into' },
  { group: 'Clip', label: 'Clip trigger style', address: '/composition/layers/{L}/clips/{C}/triggerstyle', kind: 'choice' },
  { group: 'Clip', label: 'Clip ignore column trigger', address: '/composition/layers/{L}/clips/{C}/ignorecolumntrigger', kind: 'choice', hint: 'a choice parameter at clip level, unlike the boolean layer-level version' },
  { group: 'Clip', label: 'Clip fader start', address: '/composition/layers/{L}/clips/{C}/faderstart', kind: 'choice', hint: 'a choice parameter at clip level, unlike the boolean layer-level version' },
  { group: 'Clip', label: 'Clip beat snap', address: '/composition/layers/{L}/clips/{C}/beatsnap', kind: 'choice' },
  { group: 'Clip', label: 'Clip video opacity', address: '/composition/layers/{L}/clips/{C}/video/opacity', kind: 'float', float: true },
  { group: 'Clip', label: 'Clip video mixer blend mode', address: '/composition/layers/{L}/clips/{C}/video/mixer/blendmode', kind: 'choice' },
  { group: 'Clip', label: 'Clip video source R', address: '/composition/layers/{L}/clips/{C}/video/r', kind: 'bool', values: [0, 1], hint: 'toggles the red channel of the clip source' },
  { group: 'Clip', label: 'Clip video source G', address: '/composition/layers/{L}/clips/{C}/video/g', kind: 'bool', values: [0, 1] },
  { group: 'Clip', label: 'Clip video source B', address: '/composition/layers/{L}/clips/{C}/video/b', kind: 'bool', values: [0, 1] },
  { group: 'Clip', label: 'Clip video source A', address: '/composition/layers/{L}/clips/{C}/video/a', kind: 'bool', values: [0, 1], hint: 'toggles alpha-channel use of the clip source' },
  { group: 'Clip', label: 'Clip video source param', address: '/composition/layers/{L}/clips/{C}/video/sourceparams/{P}', kind: 'float', float: true, hint: 'source-specific params for generator/input sources, e.g. a text source' },
  { group: 'Clip', label: 'Clip transition duration', address: '/composition/layers/{L}/clips/{C}/transition/duration', kind: 'float', float: true },
  { group: 'Clip', label: 'Clip transition blend mode', address: '/composition/layers/{L}/clips/{C}/transition/blendmode', kind: 'choice' },

  // ---------------------------------------------------------------- Clip transport
  { group: 'Clip transport', label: 'Clip play direction', address: '/composition/layers/{L}/clips/{C}/transport/playdirection', kind: 'choice', hint: 'forward / reverse / ping-pong (option index)' },
  { group: 'Clip transport', label: 'Clip play mode', address: '/composition/layers/{L}/clips/{C}/transport/playmode', kind: 'choice', hint: 'loop / play once / bounce while the layer is active (option index)' },
  { group: 'Clip transport', label: 'Clip play mode (layer away)', address: '/composition/layers/{L}/clips/{C}/transport/playmodeaway', kind: 'choice', hint: 'play mode used while this layer is bypassed/inactive' },
  { group: 'Clip transport', label: 'Clip transport duration', address: '/composition/layers/{L}/clips/{C}/transport/duration', kind: 'float', float: true, hint: 'loop length: beats for BPM Sync clips, seconds for Timeline clips' },
  { group: 'Clip transport', label: 'Clip transport speed', address: '/composition/layers/{L}/clips/{C}/transport/speed', kind: 'float', float: true },
  { group: 'Clip transport', label: 'Clip transport sync mode', address: '/composition/layers/{L}/clips/{C}/transport/syncmode', kind: 'choice', hint: 'BPM Sync clips only: how the clip locks to the master tempo' },
  { group: 'Clip transport', label: 'Clip transport beat loop', address: '/composition/layers/{L}/clips/{C}/transport/beatloop', kind: 'choice', hint: 'BPM Sync clips only: loop length snapped to a beat division' },

  // ---------------------------------------------------------------- Clip FX
  { group: 'Clip FX', label: 'Clip FX opacity', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/opacity', kind: 'float', float: true },
  { group: 'Clip FX', label: 'Clip FX bypassed', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Clip FX', label: 'Clip FX mixer blend mode', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/mixer/blendmode', kind: 'choice' },
  { group: 'Clip FX', label: 'Clip FX parameter', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/effect/{P}', kind: 'float', float: true, hint: 'e.g. .../flashmaster/effect/strobespeed' },
  { group: 'Clip FX', label: 'Clip FX color red', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/effect/{P}/red', kind: 'float', float: true, hint: 'ColorParameters decompose to /red /green /blue; {P} is the color param name, e.g. color1' },
  { group: 'Clip FX', label: 'Clip FX color green', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/effect/{P}/green', kind: 'float', float: true },
  { group: 'Clip FX', label: 'Clip FX color blue', address: '/composition/layers/{L}/clips/{C}/video/effects/{FX}/effect/{P}/blue', kind: 'float', float: true },
  { group: 'Clip FX', label: 'Clip audio FX bypassed', address: '/composition/layers/{L}/clips/{C}/audio/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },

  // ---------------------------------------------------------------- Composition FX
  { group: 'Composition FX', label: 'Composition FX opacity', address: '/composition/video/effects/{FX}/opacity', kind: 'float', float: true },
  { group: 'Composition FX', label: 'Composition FX bypassed', address: '/composition/video/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Composition FX', label: 'Composition FX mixer blend mode', address: '/composition/video/effects/{FX}/mixer/blendmode', kind: 'choice' },
  { group: 'Composition FX', label: 'Composition FX parameter', address: '/composition/video/effects/{FX}/effect/{P}', kind: 'float', float: true, hint: 'generic parameter for a composition-level effect (Boomer, Pusher, ColorMorph, Transform, Distortion, ...); duplicated effects get a numbered {FX} (pusher2, ...)' },
  { group: 'Composition FX', label: 'Composition FX color red', address: '/composition/video/effects/{FX}/effect/{P}/red', kind: 'float', float: true, hint: '{P} is the color param name, e.g. colormorph color1/color3' },
  { group: 'Composition FX', label: 'Composition FX color green', address: '/composition/video/effects/{FX}/effect/{P}/green', kind: 'float', float: true },
  { group: 'Composition FX', label: 'Composition FX color blue', address: '/composition/video/effects/{FX}/effect/{P}/blue', kind: 'float', float: true },
  { group: 'Composition FX', label: 'Composition audio FX bypassed', address: '/composition/audio/effects/{FX}/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Composition FX', label: 'Pusher push (white)', address: '/composition/video/effects/pusher/effect/push!', kind: 'event', values: [1], hint: 'a single push-in hit; duplicate effect instances get numbered (pusher2, pusher3, ...)' },
  { group: 'Composition FX', label: 'Boomer blur', address: '/composition/video/effects/boomer/effect/blur', kind: 'float', float: true, hint: 'Boomer beat-FX blur amount' },
  { group: 'Composition FX', label: 'ColorMorph speed', address: '/composition/video/effects/colormorph/effect/speed', kind: 'float', float: true },
  { group: 'Composition FX', label: 'Effect parameter reset', address: '/composition/video/effects/{FX}/effect/reset', kind: 'event', values: [1], hint: 'resets one effect parameter to default; the same effect/reset pattern also exists on layer, group and clip effect chains' },

  // ---------------------------------------------------------------- Audio
  { group: 'Audio', label: 'Composition audio volume', address: '/composition/audio/volume', kind: 'float', float: true },
  { group: 'Audio', label: 'Composition audio pan', address: '/composition/audio/pan', kind: 'float', float: true },
  { group: 'Audio', label: 'Layer audio volume', address: '/composition/layers/{L}/audio/volume', kind: 'float', float: true },
  { group: 'Audio', label: 'Layer audio pan', address: '/composition/layers/{L}/audio/pan', kind: 'float', float: true },
  { group: 'Audio', label: 'Group audio volume', address: '/composition/groups/{G}/audio/volume', kind: 'float', float: true },
  { group: 'Audio', label: 'Group audio pan', address: '/composition/groups/{G}/audio/pan', kind: 'float', float: true },
  { group: 'Audio', label: 'Clip audio volume', address: '/composition/layers/{L}/clips/{C}/audio/volume', kind: 'float', float: true },
  { group: 'Audio', label: 'Clip audio pan', address: '/composition/layers/{L}/clips/{C}/audio/pan', kind: 'float', float: true },

  // ---------------------------------------------------------------- Dashboard
  { group: 'Dashboard', label: 'Composition dashboard link', address: '/composition/dashboard/link{K}', kind: 'float', float: true, hint: 'quick-access dial {K} (1-8); value type follows whatever parameter is wired to that dashboard slot' },
  { group: 'Dashboard', label: 'Layer dashboard link', address: '/composition/layers/{L}/dashboard/link{K}', kind: 'float', float: true },
  { group: 'Dashboard', label: 'Group dashboard link', address: '/composition/groups/{G}/dashboard/link{K}', kind: 'float', float: true },
  { group: 'Dashboard', label: 'Clip dashboard link', address: '/composition/layers/{L}/clips/{C}/dashboard/link{K}', kind: 'float', float: true },

  // ---------------------------------------------------------------- Selected
  // Shortcuts that always target whatever is currently selected in Arena/Avenue.
  { group: 'Selected', label: 'Selected layer master', address: '/composition/layers/selected/master', kind: 'float', float: true },
  { group: 'Selected', label: 'Selected layer bypassed', address: '/composition/layers/selected/bypassed', kind: 'bool', values: [0, 1] },
  { group: 'Selected', label: 'Selected layer solo', address: '/composition/layers/selected/solo', kind: 'bool', values: [0, 1] },
  { group: 'Selected', label: 'Selected layer clear', address: '/composition/layers/selected/clear', kind: 'event', values: [1] },
  { group: 'Selected', label: 'Selected clip connect', address: '/composition/clips/selected/connect', kind: 'event', values: [1] },
  { group: 'Selected', label: 'Selected clip clear', address: '/composition/clips/selected/clear', kind: 'event', values: [1] },
  { group: 'Selected', label: 'Selected clip video opacity', address: '/composition/clips/selected/video/opacity', kind: 'float', float: true },
  { group: 'Selected', label: 'Selected clip audio volume', address: '/composition/clips/selected/audio/volume', kind: 'float', float: true },
  { group: 'Selected', label: 'Selected clip FX opacity', address: '/composition/clips/selected/video/effects/{FX}/opacity', kind: 'float', float: true },
  { group: 'Selected', label: 'Selected group master', address: '/composition/groups/selected/master', kind: 'float', float: true, hint: 'REST calls this layergroups/selected; OSC uses groups/selected' },
  { group: 'Selected', label: 'Selected group clear', address: '/composition/groups/selected/clear', kind: 'event', values: [1] },

  // ---------------------------------------------------------------- Timecode
  // Resolume's REST/OSC schema has no standalone SMPTE controller; the
  // closest genuine, swagger-backed surface is the Timeline transport's
  // frame-accurate position and the switch that puts a clip into that mode.
  { group: 'Timecode', label: 'Clip transport type', address: '/composition/layers/{L}/clips/{C}/transporttype', kind: 'choice', hint: 'Timeline (frame-accurate/timecode-style) vs BPM Sync playback model (option index)' },
  { group: 'Timecode', label: 'Clip transport position', address: '/composition/layers/{L}/clips/{C}/transport/position', kind: 'float', float: true, hint: 'frame-accurate scrub position within the clip, 0..1 normalized' },
  { group: 'Timecode', label: 'Selected clip transport position', address: '/composition/clips/selected/transport/position', kind: 'float', float: true, hint: 'scrub position of whichever clip is currently selected in Arena/Avenue' },
];

export function placeholders(address) {
  return [...address.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
}

export function expand(address, subs) {
  return address.replace(/\{(\w+)\}/g, (_, k) => String(subs[k] ?? 1));
}

// Ordered list of every group name that appears in LIBRARY, first-appearance order.
export const GROUPS = [...new Set(LIBRARY.map(e => e.group))];

// Case-insensitive, whitespace-split, AND-matched search over label/address/group/hint.
export function search(query) {
  const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return LIBRARY.slice();
  return LIBRARY.filter(entry => {
    const haystack = `${entry.label} ${entry.address} ${entry.group} ${entry.hint || ''}`.toLowerCase();
    return terms.every(t => haystack.includes(t));
  });
}
