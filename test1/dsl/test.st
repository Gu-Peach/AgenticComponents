(* The palletizing cell. Palletizer, the cell's program, is ladder; PalletTruck, the block each pallet truck runs,
   and MutingSeq, the light curtains' muting, are Structured Text, called as boxes on Palletizer's rungs. The
   Controller runs Palletizer as Main. *)

(* One pallet truck's trips, a move at a time. A trip runs out along its waypoints (WayOut rows from WayBase), into
   the pick (five rows from the pick's base), forks up, down the aisle (WayMid rows), into the drop bay for this trip's
   Slot (four rows from DropBase), forks down, and home (WayIn rows). Each move is sent as a route row on Cmd with an
   Exec pulse, and the next waits until the truck has left Idle and come back to it.
   Want / Grant is the handshake for a shared aisle: Want asks for it, Grant lets the truck go. The demo's two trucks
   share none, so both are always granted.
   Each trip fills the next slot. Done latches once the last one is filled, and the truck takes no more requests:
   for the rack truck that is the end state of a long run, the rack full and the lane left standing full. *)
FUNCTION_BLOCK PalletTruck
VAR_INPUT
  Enable   : BOOL;
  Request  : BOOL;
  Idle     : BOOL;
  Grant    : BOOL;
  PickBase : INT;
  PickStride : INT;
  WayBase  : INT;
  WayOut   : INT;
  WayMid   : INT;
  WayIn    : INT;
  DropBase : INT;
  Slots    : INT;
END_VAR
VAR_OUTPUT
  Cmd  : INT;
  Exec : BOOL;
  Fork : BOOL;
  Want : BOOL;
  Step : INT;
  Slot : INT;
  Done : BOOL;
END_VAR
VAR
  Moving  : BOOL;
  Started : BOOL;
  Send    : INT;
  wi      : INT;
  Lift    : TON;
  Drop    : TON;
  pk      : INT;
END_VAR

IF Moving THEN
  IF NOT Idle THEN Started := TRUE; END_IF;
  IF Started THEN Exec := FALSE; END_IF;
  IF Started AND Idle THEN Moving := FALSE; END_IF;
END_IF;

Lift(IN := Enable AND (Step = 20) AND NOT Moving, PT := T#600ms);
Drop(IN := Enable AND (Step = 30) AND NOT Moving, PT := T#600ms);

(* this trip's pick: PickStride 0 picks from the same rows every trip; above 0, each trip's pick starts that many
   rows further on *)
pk :=PickBase + PickStride * Slot;
Send := -1;
IF Enable THEN
  CASE Step OF
    0:  IF Request AND Idle AND NOT Done THEN Want := TRUE;         Step := 5;  END_IF;
    5:  IF Grant THEN wi := 0;                                      Step := 6;  END_IF;
    6:  IF NOT Moving THEN
          IF wi < WayOut THEN  Send := WayBase + wi; wi := wi + 1;
          ELSE                 Send := pk;                    Step := 12; END_IF;
        END_IF;
    12: IF NOT Moving THEN     Send := pk + 1;                Step := 14; END_IF;
    14: IF NOT Moving THEN     Send := pk + 2;                Step := 16; END_IF;
    16: IF NOT Moving THEN     Send := pk + 3;                Step := 20; END_IF;
    20: IF NOT Moving THEN
          Fork := TRUE;
          IF Lift.Q THEN       Send := pk + 4; wi := 0;       Step := 22; END_IF;
        END_IF;
    22: IF NOT Moving THEN
          IF wi < WayMid THEN  Send := WayBase + WayOut + wi; wi := wi + 1;
          ELSE                 Send := DropBase + 4 * Slot;         Step := 24; END_IF;
        END_IF;
    24: IF NOT Moving THEN     Send := DropBase + 4 * Slot + 1;     Step := 25; END_IF;
    25: IF NOT Moving THEN     Send := DropBase + 4 * Slot + 2;     Step := 30; END_IF;
    30: IF NOT Moving THEN
          Fork := FALSE;
          IF Drop.Q THEN       Send := DropBase + 4 * Slot + 3; wi := 0; Step := 32; END_IF;
        END_IF;
    32: IF NOT Moving THEN
          IF wi < WayIn THEN   Send := WayBase + WayOut + WayMid + wi; wi := wi + 1;
          ELSE
            Slot := Slot + 1;
            IF Slot > Slots - 1 THEN Slot := Slots - 1; Done := TRUE; END_IF;
            Send := 0;                                             Step := 40;
          END_IF;
        END_IF;
    40: IF NOT Moving THEN      Want := FALSE;                      Step := 0;  END_IF;
  END_CASE;
END_IF;
IF Send >= 0 THEN
  Cmd := Send; Exec := TRUE; Moving := TRUE; Started := FALSE;
END_IF;
END_FUNCTION_BLOCK

(* Two-sensor sequential muting for a light curtain on a one-way conveyor opening, the muting ended by the curtain
   (the arrangement PLCopen Safety's SF_MutingSeq generalises, here in the variant where the curtain itself, not a
   second pair of eyes past it, ends the muting).
   A1 A2 | curtain along the direction of travel, A1 the outer eye. A load arriving blocks A1, then A2 while A1 is still
   blocked: that ORDER starts the muting. It ends once the load has broken the curtain and the curtain is clear again
   with both eyes clear, so it closes as soon as the load's tail is through. Someone who walks in after that trips it;
   someone close enough behind the load to block an eye before its tail clears the curtain keeps the muting open and
   gets through, which is the limit of any muting by eyes, and why their spacing matters.
   Anything else that breaks the curtain (a person, a box set down in the opening, a load coming the wrong way, which
   meets the curtain before any eye) drops Clear; blocking only the eyes never does. MaxTime ends a muting that lasts
   too long, a load parked in the opening. On a real line this runs in the SAFETY program; its settings and the eyes'
   spacing are the engineer's to get right. *)
FUNCTION_BLOCK MutingSeq
VAR_INPUT
  Enable  : BOOL;
  Ossd    : BOOL;
  A1      : BOOL;
  A2      : BOOL;
  MaxTime : TIME;
END_VAR
VAR_OUTPUT
  Clear   : BOOL;
  Muted   : BOOL;
  Expired : BOOL;
END_VAR
VAR
  State   : INT; (* 0 idle, 1 the outer eye blocked, 2 muted, 9 expired *)
  Broken  : BOOL; (* the load has reached the curtain in this muting *)
  Limit   : TON;
END_VAR

IF NOT Enable THEN
  State := 0;
ELSE
  CASE State OF
    0: IF A1 AND NOT A2 THEN State := 1; END_IF;
    1: IF NOT A1 THEN State := 0; ELSIF A2 THEN State := 2; Broken := FALSE; END_IF;
    2: IF NOT Ossd THEN Broken := TRUE; END_IF;
       IF Broken AND Ossd AND NOT (A1 OR A2) THEN State := 0; END_IF;
    9: IF NOT (A1 OR A2) THEN State := 0; END_IF;
  END_CASE;
END_IF;
Limit(IN := State = 2, PT := MaxTime);
IF Limit.Q THEN State := 9; END_IF;
Muted := State = 2;
Expired := State = 9;
Clear := Ossd OR Muted;
END_FUNCTION_BLOCK

PROGRAM Palletizer
VAR
  running    : BOOL := TRUE;
  CaseMuting : MutingSeq;
  FeedMuting : MutingSeq;
  OutMuting  : MutingSeq;
  caseClear  : BOOL := TRUE;
  feedClear  : BOOL := TRUE;
  outClear   : BOOL := TRUE;

  InfeedSpeed : REAL := 1.0;
  RunSpeed   : REAL := 1.0;
  ShiftRate  : REAL := 1.0;
  safe       : BOOL;

  rowPhase   : INT;
  rowsPushed : INT;
  turnedFirst : BOOL;
  thisRowTurned : BOOL;
  rowTarget  : INT;
  rowSent    : INT;
  RowPacked  : TON;
  rowDone    : BOOL;
  shifting   : BOOL;
  ShiftPulse : TON;
  Raised     : TON;
  Shifted    : R_TRIG;
  layerDone  : BOOL;

  Step       : INT;
  OutStep    : INT := 100;
  Moving     : BOOL;
  Started    : BOOL;
  InPlace    : TON;
  TurnSettle : TON;
  LoadLeft   : F_TRIG;

  layerIdx   : INT;
  placeIdx   : INT;
  palletFull : BOOL := TRUE;
  picking    : BOOL;

  LineSpeed  : REAL := 0.4;
  FeedSpeed  : REAL := 0.6;
  PalletFeed : BOOL;

  outRun     : BOOL;
  laneRun    : BOOL;
  blocked    : BOOL;

  Truck      : PalletTruck;
  TruckStep  : INT;
  TruckSlot  : INT;
  TruckDone  : BOOL;
  Supply     : PalletTruck;
  MagEmpty   : TON;
  S3Step     : INT;
  S3Slot     : INT;
  S3Done     : BOOL;

  (* what a rung has to hold in a variable: a number tested as a bit, a step as the scan found it *)
  half, even : INT;
  phase0, phase1 : BOOL;
  armNow, outNow : INT;
  lastLayer, outIdle, layerStep : BOOL;
  request, resupply : BOOL;
  feeding, shiftRun, outMoving, deckMoving, turnMoving, laneMoving, feedRun : BOOL;

  (* the tower's green, and the Start lamp's steady light: on while the line is moving *)
  RunLamp    : BOOL;
  (* the Start lamp's flasher: two timers that run each other, half a second lit and half dark *)
  BlinkOn    : TON;
  BlinkOff   : TON;
  ready      : BOOL;
  (* something that drops the run: an E-stop struck, the guard open, a curtain broken unmuted *)
  tripCause  : BOOL;
  (* the scan the run dropped *)
  RunFell    : F_TRIG;
  (* the run was dropped by a trip, not by an operator Stop; held until the line runs again *)
  tripped    : BOOL;
  (* every emergency stop on the line released: their normally-closed contacts in series, as on a safety relay *)
  eStopOk    : BOOL;
END_VAR
LADDER
  (* the emergency stops: the operator station's, the trailer's, the cell gate's, the pallet supply's and the
     outfeed's. Any one struck stops the whole line, the flex in the trailer with it *)
  |EStop| |EStopDock| |EStopGate| |EStopSupply| |EStopOutfeed| (eStopOk);
  |eStopOk| (FlexRun);
  (* each conveyor opening's curtain, muted for a load arriving the way loads do (MutingSeq); the muting lights the
     curtain's lamp *)
  CaseMuting(Enable, Ossd := CaseCurtain, A1 := CaseMuteA1, A2 := CaseMuteA2, MaxTime := T#30s, Clear => caseClear, Muted => CaseMuted);
  FeedMuting(Enable, Ossd := FeedCurtain, A1 := FeedMuteA1, A2 := FeedMuteA2, MaxTime := T#30s, Clear => feedClear, Muted => FeedMuted);
  OutMuting(Enable, Ossd := OutCurtain, A1 := OutMuteA1, A2 := OutMuteA2, MaxTime := T#30s, Clear => outClear, Muted => OutMuted);
  (* the line runs from Start until Stop, an E-stop, the guard opening or a curtain tripping unmuted. Each of those
     drops the run itself, not just a permit, so closing the guard or clearing a beam never restarts the line: it
     needs a Start to come back *)
  [|Start|, |running|] |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (running);
  (* safe: every drive and the robot may move. Today that is the run itself, which already holds every E-stop, the
     guard and the curtains *)
  |running| (safe);
  (* the robot moves only while it is safe to run: open the guard and it brakes where it is, job and all, and carries
     on from there after a Start *)
  |safe| (ArmEnable);
  (* the machines that run a cycle of their own, the wrapper, the pallet dispenser and the turntable, are held the
     same way: a Stop or a trip stops them where they are, mid-cycle, and they carry on from there after a Start, so
     a load is never left half-wrapped *)
  |safe| (CycleEnable);
  (* odd layers start with the turned row; a turned row is three cases, a straight one two *)
  DIV(IN1 := layerIdx, IN2 := 2, OUT => half);
  MUL(IN1 := half, IN2 := 2, OUT => even);
  NE(IN1 := layerIdx, IN2 := even, OUT) (turnedFirst);
  EQ(IN1 := rowPhase, IN2 := 0, OUT) (phase0);
  EQ(IN1 := rowPhase, IN2 := 1, OUT) (phase1);
  [|turnedFirst| |phase0|, |/turnedFirst| |phase1|] (thisRowTurned);
  SEL(G := thisRowTurned, IN0 := 2, IN1 := 3, OUT => rowTarget);
  (* a case arriving at the eye counts toward the row, and toward the running total *)
  |P BoxAtEye| ADD(IN1 := rowSent, IN2 := 1, OUT => rowSent) ADD(IN1 := Cases, IN2 := 1, OUT => Cases);
  (* a packed row pushes across once the stop has held it a second, twice a layer *)
  GE(IN1 := rowSent, IN2 := rowTarget, OUT) |RowReady| |/shifting| |/picking| RowPacked(IN, PT := T#1000ms);
  LT(IN1 := rowsPushed, IN2 := 2, OUT) |RowPacked.Q| |/shifting| (rowDone);
  [|rowDone|, |shifting|] |/ShiftPulse.Q| (shifting);
  |shifting| ShiftPulse(IN, PT := T#2000ms);
  |shifting| Raised(IN, PT := T#200ms);
  EQ(IN1 := rowsPushed, IN2 := 0, OUT) |P shifting| MOVE(IN := 1, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent);
  |ShiftPulse.Q| Shifted(CLK) ADD(IN1 := rowsPushed, IN2 := 1, OUT => rowsPushed);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |Shifted.Q| MOVE(IN := 0, OUT => rowSent);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |LayerReady| (layerDone);
  (* the arm: a job has started once the robot leaves idle, and is over when it is idle again *)
  |Moving| |/ArmIdle| (S Started);
  |Moving| |Started| (R ArmExec);
  |Moving| |Started| |ArmIdle| (R Moving);
  |PalletFeed| |PalletIn| InPlace(IN, PT := T#800ms);
  EQ(IN1 := OutStep, IN2 := 115, OUT) TurnSettle(IN, PT := T#1200ms);
  |LoadOut| LoadLeft(CLK);
  (* the arm's cycle: every step tests the step as the scan found it. The robot runs its own jobs (its Inspector):
     job 1 picks the layer and lifts it clear, job 2 + n places it as course n and goes home *)
  MOVE(IN := Step, OUT => armNow);
  GE(IN1 := placeIdx, IN2 := ${COURSES - 1}, OUT) (lastLayer);
  EQ(IN1 := OutStep, IN2 := 0, OUT) (outIdle);
  (* 0: a layer is ready and the pallet has room: pick it *)
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| (R picking);
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| |layerDone| |/palletFull| MOVE(IN := layerIdx, OUT => placeIdx) MOVE(IN := 1, OUT => ArmCmd) MOVE(IN := 10, OUT => Step) (S ArmExec) (S Moving) (R Started) (S picking);
  (* 10: the layer is up off the deck, so the deck is clear for the next one; place this one *)
  EQ(IN1 := armNow, IN2 := 10, OUT) |safe| |/Moving| MOVE(IN := 0, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent) MOVE(IN := 0, OUT => rowsPushed) ADD(IN1 := layerIdx, IN2 := 1, OUT => layerIdx) ADD(IN1 := placeIdx, IN2 := 2, OUT => ArmCmd) MOVE(IN := 20, OUT => Step) (R picking) (S ArmExec) (S Moving) (R Started) (layerStep);
  GE(IN1 := layerIdx, IN2 := ${COURSES}, OUT) |layerStep| MOVE(IN := 0, OUT => layerIdx);
  (* 20: placed and home; after the last layer the pallet goes out, once the outfeed is free *)
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |lastLayer| |outIdle| MOVE(IN := 100, OUT => OutStep) MOVE(IN := 0, OUT => Step) (S palletFull);
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |/lastLayer| MOVE(IN := 0, OUT => Step);
  (* the outfeed: its steps test the step as the scan found it, after the arm may have started it *)
  MOVE(IN := OutStep, OUT => outNow);
  (* 100: the load may leave once the staging lane is clear: square the turntable to receive it. A load leaving the
     cell counts toward the running total *)
  EQ(IN1 := outNow, IN2 := 100, OUT) |safe| |/LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 105, OUT => OutStep) ADD(IN1 := Pallets, IN2 := 1, OUT => Pallets);
  (* 105: the turntable is square: run the load off the deck, toward the wrapper *)
  EQ(IN1 := outNow, IN2 := 105, OUT) |safe| |TurnDone| MOVE(IN := 106, OUT => OutStep) (S outRun);
  (* 106: into the stretch wrapper; its station eye stops the load under the arm, and one edge on WrapStart wraps it *)
  EQ(IN1 := outNow, IN2 := 106, OUT) |safe| |WrapInPos| MOVE(IN := 107, OUT => OutStep) (R outRun) (S WrapStart);
  (* 107: wrapped and the arm parked: on to the turntable *)
  EQ(IN1 := outNow, IN2 := 107, OUT) |safe| |WrapDone| MOVE(IN := 110, OUT => OutStep) (R WrapStart) (S outRun);
  (* 110: the pallet is on the turntable; it settles, then turns a quarter to face the lane *)
  EQ(IN1 := outNow, IN2 := 110, OUT) |safe| |TurnEye| MOVE(IN := 115, OUT => OutStep) (R outRun);
  EQ(IN1 := outNow, IN2 := 115, OUT) |safe| |TurnSettle.Q| MOVE(IN := -90.0, OUT => TurnCmd) MOVE(IN := 120, OUT => OutStep);
  EQ(IN1 := outNow, IN2 := 120, OUT) |safe| |TurnDone| MOVE(IN := 130, OUT => OutStep) (S laneRun);
  (* 130: into the lane until it is full *)
  EQ(IN1 := outNow, IN2 := 130, OUT) |safe| |LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 140, OUT => OutStep) (R laneRun);
  (* 140: square again for the next load *)
  EQ(IN1 := outNow, IN2 := 140, OUT) |safe| |TurnDone| MOVE(IN := 0, OUT => OutStep);
  (* the empty pallet that replaces it is fed as soon as the finished load is off the build deck, not when it
     reaches the turntable, so the arm is not left waiting out the rest of the route; it is in once it has stood
     against the stop for a moment *)
  |safe| |palletFull| |LoadLeft.Q| (S PalletFeed);
  |safe| |PalletFeed| |InPlace.Q| (R PalletFeed) (R palletFull);
  (* the rack truck fetches the load once the lane is full, and not while it is still filling. A truck box's power
     flow in is its Enable and out is its Exec, which is what the coil after it carries to the truck *)
  |LaneFull| |/laneRun| (request);
  |safe| Truck(Enable, Idle := RackIdle, Grant := TRUE, Request := request, PickBase := ${AGV_PICK_BASE}, WayBase := ${AGV_WAY_BASE}, WayOut := ${RACK_WAYS.out}, WayMid := ${RACK_WAYS.mid}, WayIn := ${RACK_WAYS.in}, DropBase := ${RACK_BAY_BASE}, Slots := ${RACK_SLOTS}, Cmd => RackCmd, Fork => RackFork, Step => TruckStep, Slot => TruckSlot, Done => TruckDone) (RackExec);
  (* the supply truck loads the dispenser once its magazine is empty and nothing is waiting in its bay - held a second,
     because the magazine reads empty the moment its last pallet is set down, a moment before the bay eye sees it *)
  EQ(IN1 := MagLevel, IN2 := 0, OUT) |/PalletReady| MagEmpty(IN, PT := T#1000ms);
  |MagEmpty.Q| (resupply);
  |safe| Supply(Enable, Idle := SupplyIdle, Grant := TRUE, Request := resupply, PickBase := ${SUPPLY.pickBase}, PickStride := ${SUPPLY.pickStride}, WayBase := 0, WayOut := 0, WayMid := 0, WayIn := 0, DropBase := ${SUPPLY.dropBase}, Slots := ${SUPPLY.slots}, Cmd => SupplyCmd, Fork => SupplyFork, Step => S3Step, Slot => S3Slot, Done => S3Done) (SupplyExec);
  (* the drives: at their speed, or stopped *)
  |safe| |/picking| (feeding);
  SEL(G := feeding, IN0 := 0.0, IN1 := InfeedSpeed, OUT => Infeed);
  SEL(G := feeding, IN0 := 0.0, IN1 := RunSpeed, OUT => RowForm);
  |safe| |shifting| |Raised.Q| (shiftRun);
  SEL(G := shiftRun, IN0 := 0.0, IN1 := ShiftRate, OUT => ShiftSpeed);
  LT(IN1 := rowSent, IN2 := rowTarget, OUT) |safe| |/layerDone| |/picking| (SpawnRun);
  (* the trailer unloader's load light: put cases on the flex while there is room at its load point *)
  |safe| |/FlexFull| (LoadFlex);
  |safe| |outRun| (outMoving);
  SEL(G := outMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => PalletOut);
  (* the build deck runs only until the load is off it: the fresh pallet lands on it while the outfeed still runs *)
  |safe| |outRun| |palletFull| |/PalletFeed| (deckMoving);
  SEL(G := deckMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => DeckRun);
  |safe| [|outRun|, |laneRun|] (turnMoving);
  SEL(G := turnMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => TurnRun);
  |safe| |laneRun| (laneMoving);
  SEL(G := laneMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => Lane);
  (* the pallet supply: the transfer is up for the whole feed, the infeed and chains run once the dispenser lets go *)
  |safe| |PalletFeed| (PalletLift);
  |safe| |PalletFeed| |/DispBusy| (feedRun);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletInfeed);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletXfer);
  (* ...and between feeds the dispenser keeps a pallet waiting in its bay *)
  |safe| |/PalletFeed| |/PalletReady| |/DispBusy| (PalletDispense);
  (* the row former: Turn puts its turning plow into the lane for a turned row (nothing to do with the outfeed
     turntable's TurnCmd, TurnRun and TurnDone), and Shift raises the chains that push a packed row across *)
  |safe| |thisRowTurned| (Turn);
  |shifting| |safe| (Shift);
  (* the tower, a bit per lamp (1 green, 2 amber, 4 red): green running, amber the finished load has no lane to go
     to, red an E-stop struck or the guard open. Red is the emergency colour (IEC 60204-1), so neither a normal Stop
     nor a curtain trip is red: the tower goes dark, and the flashing Start lamp is what tells a trip from a Stop *)
  |safe| (RunLamp);
  EQ(IN1 := OutStep, IN2 := 100, OUT) |LaneFull| (blocked);
  MOVE(IN := 0, OUT => Tower);
  |RunLamp| ADD(IN1 := Tower, IN2 := 1, OUT => Tower);
  |blocked| ADD(IN1 := Tower, IN2 := 2, OUT => Tower);
  [|/eStopOk|, |/Guard|] ADD(IN1 := Tower, IN2 := 4, OUT => Tower);
  (* the Start lamp: steady while the line is moving, flashing while a TRIP left it down and a Start would bring it
     back (every E-stop released, the guard closed, every curtain clear), so the line says what it is waiting for. An
     operator Stop is not a trip, and nor is anything that happens to a line already stopped: it is down on purpose
     and the lamp stays dark, since a flash asks for attention. So a trip is latched only on the scan the run drops *)
  |/BlinkOff.Q| BlinkOn(IN, PT := T#500ms);
  |BlinkOn.Q| BlinkOff(IN, PT := T#500ms);
  [|/eStopOk|, |/Guard|, |/caseClear|, |/feedClear|, |/outClear|] (tripCause);
  |running| RunFell(CLK);
  [|RunFell.Q| |tripCause|, |tripped|] |/running| (tripped);
  |/running| |tripped| |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (ready);
  [|RunLamp|, |ready| |BlinkOn.Q|] (StartLamp);
END_LADDER
END_PROGRAM

(* The controller's tags: the cell's I/O, which the scene is wired to by name, and which the program reads and
   writes *)
VAR_INPUT
  Start      : BOOL;
  Stop       : BOOL := TRUE;
  EStop      : BOOL := TRUE;
  EStopDock  : BOOL := TRUE;
  EStopGate  : BOOL := TRUE;
  EStopSupply : BOOL := TRUE;
  EStopOutfeed : BOOL := TRUE;
  Guard      : BOOL := TRUE;
  CaseCurtain : BOOL := TRUE;
  FeedCurtain : BOOL := TRUE;
  OutCurtain : BOOL := TRUE;
  CaseMuteA1, CaseMuteA2 : BOOL;
  FeedMuteA1, FeedMuteA2 : BOOL;
  OutMuteA1, OutMuteA2 : BOOL;
  BoxAtEye   : BOOL;
  RowReady   : BOOL;
  LayerReady : BOOL;
  ArmIdle    : BOOL;
  TurnDone   : BOOL := TRUE;
  TurnEye    : BOOL;
  LoadOut    : BOOL;
  LaneFull   : BOOL;
  RackIdle   : BOOL := TRUE;
  SupplyIdle : BOOL := TRUE;
  PalletIn   : BOOL;
  DispBusy   : BOOL;
  PalletReady : BOOL;
  MagLevel   : INT := -1;
  WrapInPos  : BOOL;
  WrapDone   : BOOL;
  FlexFull   : BOOL;
END_VAR
VAR_OUTPUT
  Infeed     : REAL;
  RowForm    : REAL;
  ShiftSpeed : REAL;
  SpawnRun   : BOOL;
  LoadFlex   : BOOL;
  FlexRun    : BOOL;
  Turn       : BOOL;
  Shift      : BOOL;
  ArmCmd     : INT;
  ArmExec    : BOOL;
  ArmEnable  : BOOL;
  PalletOut  : REAL;
  DeckRun    : REAL;
  TurnRun    : REAL;
  TurnCmd    : REAL;
  Lane       : REAL;
  RackCmd    : INT;
  RackExec   : BOOL;
  RackFork   : BOOL;
  SupplyCmd  : INT;
  SupplyExec : BOOL;
  SupplyFork : BOOL;
  PalletDispense : BOOL;
  PalletLift : BOOL;
  PalletInfeed : REAL;
  PalletXfer : REAL;
  WrapStart  : BOOL;
  CycleEnable : BOOL;
  CaseMuted, FeedMuted, OutMuted : BOOL;
  StartLamp  : BOOL;
  Tower      : INT;
  Cases      : DINT;
  Pallets    : DINT;
END_VAR