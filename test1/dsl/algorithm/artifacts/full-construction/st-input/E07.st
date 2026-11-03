(* Generic experimental request protocol; external plant facts are explicit inputs.
   No vendor library and no physical deployment/equivalence claim. *)
FUNCTION_BLOCK AC_Request
VAR_INPUT
  Enable : BOOL; Start : BOOL; Stop : BOOL; Reset : BOOL;
  RunId : DINT; RequestId : DINT;
  Ack : BOOL; AckRun : DINT; AckId : DINT;
  ResultDone : BOOL; ResultRun : DINT; ResultId : DINT;
  ResultFault : BOOL;
  StopAck : BOOL; StopRun : DINT; StopId : DINT; SafeToRelease : BOOL;
  AcceptLimit : TIME; ExecuteLimit : TIME; StopLimit : TIME;
END_VAR
VAR_OUTPUT
  CommandRun : DINT; CommandId : DINT;
  Execute : BOOL; Cancel : BOOL; Busy : BOOL;
  Done : BOOL; Failed : BOOL; NeedsAttention : BOOL;
END_VAR
VAR
  State : DINT; AcceptTimer : TON; ExecuteTimer : TON; StopTimer : TON;
  MatchAck : BOOL; MatchResult : BOOL; MatchStop : BOOL;
END_VAR
IF Reset AND ((State = 0) OR (State = 90)) THEN
  State := 0; Done := FALSE; Failed := FALSE; NeedsAttention := FALSE;
END_IF;
MatchAck := Ack AND (AckRun = CommandRun) AND (AckId = CommandId);
MatchResult := (ResultRun = CommandRun) AND (ResultId = CommandId);
MatchStop := StopAck AND (StopRun = CommandRun) AND (StopId = CommandId);
AcceptTimer(IN := State = 10, PT := AcceptLimit);
ExecuteTimer(IN := State = 20, PT := ExecuteLimit);
StopTimer(IN := State = 30, PT := StopLimit);
CASE State OF
  0:
    Execute := FALSE; Cancel := FALSE; Busy := FALSE;
    IF Enable AND Start AND (RequestId > 0) AND (RunId > 0) THEN
      CommandRun := RunId; CommandId := RequestId;
      Done := FALSE; Failed := FALSE; Busy := TRUE; Execute := TRUE; State := 10;
    END_IF;
  10:
    IF Stop OR NOT Enable OR (ResultFault AND MatchResult) THEN
      Execute := FALSE; Cancel := TRUE; State := 30;
    ELSIF MatchAck THEN
      Execute := FALSE;
      IF ResultDone AND MatchResult THEN Done := TRUE; Busy := FALSE; State := 90;
      ELSE State := 20; END_IF;
    ELSIF AcceptTimer.Q THEN Execute := FALSE; Cancel := TRUE; State := 30;
    END_IF;
  20:
    IF Stop OR NOT Enable OR (ResultFault AND MatchResult) THEN Cancel := TRUE; State := 30;
    ELSIF ResultDone AND MatchResult THEN Done := TRUE; Busy := FALSE; State := 90;
    ELSIF ExecuteTimer.Q THEN Cancel := TRUE; State := 30;
    END_IF;
  30:
    Execute := FALSE; Cancel := TRUE;
    IF MatchStop AND SafeToRelease THEN
      Cancel := FALSE; Busy := FALSE; Failed := TRUE; NeedsAttention := FALSE; State := 90;
    ELSIF StopTimer.Q THEN NeedsAttention := TRUE;
    END_IF;
  90: Execute := FALSE; Busy := FALSE;
END_CASE;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  Enable : BOOL; Stop : BOOL; RunId : DINT := 1;
  StepNo : DINT; Phase : DINT;
  PreviousStep : DINT := -1; WaitArmed : BOOL;
  StartRequest : BOOL; ResetRequest : BOOL; AbortRequested : BOOL;
  Ack : BOOL; AckRun : DINT; AckId : DINT;
  ResultDone : BOOL; ResultFault : BOOL; ResultRun : DINT; ResultId : DINT;
  StopAck : BOOL; StopRun : DINT; StopId : DINT; SafeToRelease : BOOL;
  AllScopesStopped : BOOL; IndependentGoal : BOOL;
  Completed : BOOL; Failed : BOOL; AbortAllScopes : BOOL; NeedsAttention : BOOL;
  CommandDevice : DINT; CommandAction : DINT; CommandSubject : DINT;
  CommandSource : DINT; CommandTarget : DINT; CommandScope : DINT; CommandIndex : DINT;
  WaitLimit : TIME := T#30s; WaitTimer : TON; GateTimer : TON; Req : AC_Request;
  Condition_0 : BOOL;
  Condition_13 : BOOL;
  Ready_1 : BOOL;
  Ready_2 : BOOL;
  Ready_3 : BOOL;
  Ready_4 : BOOL;
  Ready_5 : BOOL;
  Ready_6 : BOOL;
  Ready_7 : BOOL;
  Ready_8 : BOOL;
  Ready_9 : BOOL;
  Ready_10 : BOOL;
  Ready_11 : BOOL;
  Ready_12 : BOOL;
END_VAR
StartRequest := FALSE; ResetRequest := FALSE;
IF (Stop OR (NOT Enable AND ((StepNo > 0) OR Req.Busy))) AND NOT Completed THEN AbortRequested := TRUE; END_IF;
CASE StepNo OF
  0: WaitLimit := T#30s;
  13: WaitLimit := T#30s;
END_CASE;
WaitArmed := StepNo = PreviousStep; PreviousStep := StepNo;
GateTimer(IN := Enable AND NOT AbortRequested AND (Phase = 1), PT := T#30000ms);
WaitTimer(IN := Enable AND NOT AbortRequested AND WaitArmed AND ((StepNo = 0) OR (StepNo = 13)), PT := WaitLimit);
IF Enable AND NOT AbortRequested THEN
CASE StepNo OF
  0:
    IF Condition_0 THEN StepNo := 1; Phase := 0;
    ELSIF WaitTimer.Q THEN AbortRequested := TRUE; END_IF;
  1:
    CommandDevice := 1; CommandAction := 1; CommandSubject := 2; CommandSource := 3; CommandTarget := 4; CommandScope := 5; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_1 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  2:
    CommandDevice := 6; CommandAction := 2; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 7; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_2 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  3:
    CommandDevice := 6; CommandAction := 3; CommandSubject := 2; CommandSource := 5; CommandTarget := 5; CommandScope := 7; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_3 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  4:
    CommandDevice := 6; CommandAction := 4; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 7; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_4 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  5:
    CommandDevice := 1; CommandAction := 1; CommandSubject := 8; CommandSource := 9; CommandTarget := 4; CommandScope := 5; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_5 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  6:
    CommandDevice := 6; CommandAction := 2; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 10; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_6 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  7:
    CommandDevice := 6; CommandAction := 3; CommandSubject := 8; CommandSource := 5; CommandTarget := 5; CommandScope := 10; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_7 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  8:
    CommandDevice := 6; CommandAction := 4; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 10; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_8 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  9:
    CommandDevice := 1; CommandAction := 1; CommandSubject := 11; CommandSource := 12; CommandTarget := 4; CommandScope := 5; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_9 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  10:
    CommandDevice := 6; CommandAction := 2; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 13; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_10 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  11:
    CommandDevice := 6; CommandAction := 3; CommandSubject := 11; CommandSource := 5; CommandTarget := 5; CommandScope := 13; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_11 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  12:
    CommandDevice := 6; CommandAction := 4; CommandSubject := 5; CommandSource := 5; CommandTarget := 5; CommandScope := 13; CommandIndex := 0;
    CASE Phase OF
      0: ResetRequest := TRUE; Phase := 1;
      1: IF Ready_12 THEN StartRequest := TRUE; Phase := 2; ELSIF GateTimer.Q THEN AbortRequested := TRUE; END_IF;
    END_CASE;
  13:
    IF Condition_13 THEN StepNo := 14; Phase := 0;
    ELSIF WaitTimer.Q THEN AbortRequested := TRUE; END_IF;
  14: Completed := TRUE;
END_CASE;
END_IF;
Req(Enable := Enable, Start := StartRequest, Stop := AbortRequested, Reset := ResetRequest,
    RunId := RunId, RequestId := StepNo + 1,
    Ack := Ack, AckRun := AckRun, AckId := AckId,
    ResultDone := ResultDone, ResultRun := ResultRun, ResultId := ResultId, ResultFault := ResultFault,
    StopAck := StopAck, StopRun := StopRun, StopId := StopId, SafeToRelease := SafeToRelease,
    AcceptLimit := T#2000ms, ExecuteLimit := T#30000ms, StopLimit := T#5000ms);
IF (Phase = 2) AND Req.Done AND NOT AbortRequested THEN StepNo := StepNo + 1; Phase := 0; END_IF;
IF Req.Failed OR Req.NeedsAttention THEN AbortRequested := TRUE; END_IF;
AbortAllScopes := AbortRequested;
NeedsAttention := Req.NeedsAttention OR (AbortRequested AND NOT AllScopesStopped);
IF AbortRequested AND AllScopesStopped AND NOT Req.Busy THEN Failed := TRUE; Completed := FALSE; END_IF;
(* IndependentGoal is monitored separately; it is not used to repair candidate logic. *)
END_PROGRAM
