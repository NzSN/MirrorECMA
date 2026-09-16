------------------------- MODULE PersistentTransfer -------------------------
EXTENDS Integers, Sequences
VARIABLES
  \* @type: Int;
  session,
  \* @type: Str;
  phase,
  \* @type: Seq(Int);
  data,
  \* @type: Bool;
  committed,
  \* @type: Bool;
  accepted,
  \* @type: {token: Int, offset: Int, value: Int, step: Int};
  parameters,
  \* @type: Str;
  action_taken
Init == /\ session = 0 /\ phase = "idle" /\ data = <<>>
        /\ committed = FALSE /\ accepted = FALSE
        /\ parameters = [token |-> 0, offset |-> 0, value |-> 0, step |-> 0]
        /\ action_taken = "init"
Mark(label,t,o,v) == /\ action_taken' = label
  /\ parameters' = [token |-> t, offset |-> o, value |-> v, step |-> parameters.step + 1]
Begin == /\ phase \in {"idle","cancelled"}
  /\ session' = session + 1 /\ phase' = "open" /\ data' = <<>>
  /\ committed' = FALSE /\ accepted' = TRUE /\ Mark("begin",0,0,0)
Chunk(t,o,v) ==
  LET ok == t = session /\ phase = "open" /\ o >= 0
            /\ (o = Len(data) \/ (o < Len(data) /\ data[o+1] = v)) IN
  /\ data' = IF ok /\ o = Len(data) THEN Append(data,v) ELSE data
  /\ accepted' = ok /\ UNCHANGED <<session,phase,committed>> /\ Mark("chunk",t,o,v)
Pause == /\ phase = "open" /\ phase' = "paused"
  /\ UNCHANGED <<session,data,committed,accepted>> /\ Mark("pause",0,0,0)
Resume == /\ phase = "paused" /\ phase' = "open"
  /\ UNCHANGED <<session,data,committed,accepted>> /\ Mark("resume",0,0,0)
Restart == /\ UNCHANGED <<session,phase,data,committed,accepted>> /\ Mark("restart",0,0,0)
Commit == LET ok == phase = "open" /\ Len(data) = 2 IN
  /\ committed' = IF ok THEN TRUE ELSE committed
  /\ phase' = IF ok THEN "done" ELSE phase
  /\ accepted' = ok /\ UNCHANGED <<session,data>> /\ Mark("commit",0,0,0)
Cancel == /\ phase' = "cancelled" /\ data' = <<>> /\ committed' = FALSE
  /\ accepted' = TRUE /\ UNCHANGED session /\ Mark("cancel",0,0,0)
Next == Begin \/ Pause \/ Resume \/ Restart \/ Commit \/ Cancel
        \/ (\E t \in {1,2}, o \in {0,1}, v \in {11,22}: Chunk(t,o,v))
WitnessNext ==
  \/ (parameters.step = 0 /\ Begin)
  \/ (parameters.step = 1 /\ Chunk(1,0,11))
  \/ (parameters.step = 2 /\ Commit)
  \/ (parameters.step = 3 /\ Pause)
  \/ (parameters.step = 4 /\ Restart)
  \/ (parameters.step = 5 /\ Resume)
  \/ (parameters.step = 6 /\ Chunk(1,0,11))
  \/ (parameters.step = 7 /\ Chunk(1,1,22))
  \/ (parameters.step = 8 /\ Commit)
  \/ (parameters.step = 9 /\ Restart)
  \/ (parameters.step = 10 /\ Cancel)
  \/ (parameters.step = 11 /\ Begin)
  \/ (parameters.step = 12 /\ Chunk(1,0,11))
  \/ (parameters.step = 13 /\ Chunk(2,0,11))
  \/ (parameters.step = 14 /\ Cancel)
TraceComplete == parameters.step < 15
Safety == committed => (phase = "done" /\ Len(data) = 2)
View == <<session,phase,data,committed,accepted,parameters.step>>
=============================================================================
