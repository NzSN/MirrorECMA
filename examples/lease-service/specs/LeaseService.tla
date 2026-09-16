------------------------- MODULE LeaseService -------------------------
EXTENDS Integers, FiniteSets
VARIABLES
  \* @type: Set(Int);
  owners,
  \* @type: Int;
  epoch,
  \* @type: Int;
  expires,
  \* @type: Int;
  now,
  \* @type: Bool;
  accepted,
  \* @type: Int;
  writes,
  \* @type: {client: Int, token: Int, amount: Int, step: Int};
  parameters,
  \* @type: Str;
  action_taken
Init == /\ owners = {} /\ epoch = 0 /\ expires = 0 /\ now = 0
        /\ accepted = FALSE /\ writes = 0
        /\ parameters = [client |-> 0, token |-> 0, amount |-> 0, step |-> 0]
        /\ action_taken = "init"
Mark(label, c, t, n) ==
  /\ action_taken' = label
  /\ parameters' = [client |-> c, token |-> t, amount |-> n, step |-> parameters.step + 1]
Valid(c,t) == c \in owners /\ t = epoch /\ now < expires
Acquire(c) ==
  LET ok == owners = {} \/ now >= expires IN
  /\ owners' = IF ok THEN {c} ELSE owners
  /\ epoch' = IF ok THEN epoch + 1 ELSE epoch
  /\ expires' = IF ok THEN now + 3 ELSE expires
  /\ accepted' = ok /\ UNCHANGED <<now,writes>> /\ Mark("acquire",c,0,0)
Renew(c,t) ==
  /\ accepted' = Valid(c,t)
  /\ expires' = IF Valid(c,t) THEN now + 3 ELSE expires
  /\ UNCHANGED <<owners,epoch,now,writes>> /\ Mark("renew",c,t,0)
Release(c,t) ==
  /\ accepted' = Valid(c,t)
  /\ owners' = IF Valid(c,t) THEN {} ELSE owners
  /\ UNCHANGED <<epoch,expires,now,writes>> /\ Mark("release",c,t,0)
Write(c,t) ==
  /\ accepted' = Valid(c,t)
  /\ writes' = IF Valid(c,t) THEN writes + 1 ELSE writes
  /\ UNCHANGED <<owners,epoch,expires,now>> /\ Mark("write",c,t,0)
Advance(n) == /\ now' = now + n /\ UNCHANGED <<owners,epoch,expires,accepted,writes>>
              /\ Mark("advance",0,0,n)
Next == (\E c \in {1,2}: Acquire(c))
        \/ (\E c \in {1,2}, t \in {1,2}: Renew(c,t) \/ Release(c,t) \/ Write(c,t))
        \/ Advance(3)
WitnessNext ==
  \/ (parameters.step = 0 /\ Acquire(1))
  \/ (parameters.step = 1 /\ Acquire(2))
  \/ (parameters.step = 2 /\ Renew(1,1))
  \/ (parameters.step = 3 /\ Advance(3))
  \/ (parameters.step = 4 /\ Write(1,1))
  \/ (parameters.step = 5 /\ Acquire(2))
  \/ (parameters.step = 6 /\ Release(1,1))
  \/ (parameters.step = 7 /\ Renew(1,1))
  \/ (parameters.step = 8 /\ Write(2,2))
  \/ (parameters.step = 9 /\ Release(2,2))
TraceComplete == parameters.step < 10
Safety == Cardinality(owners) <= 1
View == <<owners,epoch,expires,now,accepted,writes,parameters.step>>
=============================================================================
