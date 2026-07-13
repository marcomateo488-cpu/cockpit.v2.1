import enum
from fastapi import HTTPException, status


class FightPhase(str, enum.Enum):
    BETTING = "BETTING"
    COCKFIGHT = "COCKFIGHT"
    REDEEMING = "REDEEMING"
    CLOSED = "CLOSED"


class FightStateService:
    """
    State manager for the current fight round/phase. In multi-server
    production, back these attributes with Redis so all worker processes /
    instances share the same phase, round, and round-readiness flag.

    Lifecycle for one cockfight:
        CLOSED (idle) --create_new_round()--> CLOSED, round ready
                       --open_betting()------> BETTING
                       --advance to COCKFIGHT-> COCKFIGHT
                       --advance to REDEEMING-> REDEEMING (also happens
                         automatically once an admin declares a fight result)
                       --advance to CLOSED----> CLOSED (idle again)

    Only the transitions listed in ALLOWED_TRANSITIONS are legal, so an
    admin can no longer jump straight from REDEEMING back into COCKFIGHT
    (or any other out-of-sequence move) by mis-clicking or mis-typing a
    phase name.
    """

    _current_phase: FightPhase = FightPhase.CLOSED
    _current_round: int = 0

    # True once a new round has been created and is waiting for betting to
    # open; consumed (set back to False) the moment betting actually opens.
    # This is what replaces the old "opening BETTING silently starts a new
    # round" behavior with an explicit, separate step.
    _round_ready: bool = False

    ALLOWED_TRANSITIONS = {
        FightPhase.CLOSED: {FightPhase.BETTING},
        FightPhase.BETTING: {FightPhase.COCKFIGHT},
        FightPhase.COCKFIGHT: {FightPhase.REDEEMING},
        FightPhase.REDEEMING: {FightPhase.CLOSED},
    }

    # ---------- read-only accessors ----------

    @classmethod
    def get_phase(cls) -> FightPhase:
        return cls._current_phase

    @classmethod
    def get_round(cls) -> int:
        return cls._current_round

    @classmethod
    def is_round_ready(cls) -> bool:
        return cls._round_ready

    # ---------- round lifecycle ----------

    @classmethod
    def create_new_round(cls) -> int:
        """
        Explicitly starts a new cockfight round. This is now its own step,
        separate from opening betting, so an admin has a clear, deliberate
        moment where "round N+1 begins" instead of that just happening as a
        side effect of clicking "Open betting."

        Only allowed while the system is idle (CLOSED) and no round is
        already sitting there waiting to be opened.
        """
        if cls._current_phase != FightPhase.CLOSED:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cannot start a new round while the system is in {cls._current_phase.value}. "
                       f"Finish the current round (advance to CLOSED) first.",
            )
        if cls._round_ready:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Round #{cls._current_round + 1} has already been created and is waiting for betting to open.",
            )
        cls._current_round += 1
        cls._round_ready = True
        return cls._current_round

    @classmethod
    def set_phase(cls, target: FightPhase) -> None:
        """
        Moves the system to `target`, but only if that's a legal next step
        from the current phase. This is what stops, e.g., accidentally
        starting a cockfight while still in REDEEMING - every transition is
        checked against ALLOWED_TRANSITIONS instead of being accepted
        unconditionally.
        """
        if target == cls._current_phase:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"System is already in {target.value}.",
            )

        allowed = cls.ALLOWED_TRANSITIONS.get(cls._current_phase, set())
        if target not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cannot move from {cls._current_phase.value} to {target.value} directly. "
                       f"Valid next step(s) from {cls._current_phase.value}: "
                       f"{', '.join(p.value for p in allowed) or 'none - round is finished'}.",
            )

        if target == FightPhase.BETTING and not cls._round_ready:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No round has been created yet. Create a new round before opening betting.",
            )

        if target == FightPhase.BETTING:
            cls._round_ready = False

        cls._current_phase = target

    @classmethod
    def full_system_reset(cls) -> None:
        """
        Hard reset of ALL in-memory fight state (phase, round counter,
        round-readiness) back to a brand new idle system - e.g. wrapping up
        for the day, or recovering from a bad state without restarting the
        server. Does NOT touch any database records (tickets/audit logs are
        untouched); it only clears the live phase/round machine so a future
        cockfight event starts clean from round #0 again.

        Only allowed while CLOSED, so this can't be used to wipe an
        in-flight round's phase/round state out from under active betting
        or redemptions.
        """
        if cls._current_phase != FightPhase.CLOSED:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cannot reset while the system is in {cls._current_phase.value}. "
                       f"Advance the current round to CLOSED first.",
            )
        cls._current_phase = FightPhase.CLOSED
        cls._current_round = 0
        cls._round_ready = False

    @classmethod
    def enforce_phase(cls, required_phase: FightPhase) -> None:
        if cls._current_phase != required_phase:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Operation rejected. System phase is currently {cls._current_phase.value}, but requires {required_phase.value}."
            )
