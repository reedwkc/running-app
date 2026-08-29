// JSDoc-only type definitions for this app's core data shapes - no runtime code.
// Referenced from other files via `import('../types.js').WorkoutLog` etc. in JSDoc
// comments. Kept intentionally focused on the shapes M3 actually types/tests against
// (data-store.js callers, goal-trajectory.js, tier-estimates.js), not an exhaustive
// model of every object in the app.

/**
 * A logged day - either a planned session actually done, a skip, or a freeform
 * (unplanned) activity saved into the same workout-w{N}-{dayTag} slot.
 * @typedef {Object} WorkoutLog
 * @property {boolean} [completed]
 * @property {boolean} [skipped]
 * @property {boolean} [swapped]
 * @property {boolean} [moved]
 * @property {boolean} [freeform]
 * @property {string} [completedAt] ISO datetime
 * @property {string} [skippedAt] ISO datetime
 * @property {string} [performedOnTag]
 * @property {string} [skipReason]
 * @property {number|string} [rpe]
 * @property {number|string} [avgHR]
 * @property {string} [loadStatus]
 * @property {number} [sessionLoad]
 * @property {number} [acuteLoad]
 * @property {number} [chronicLoad]
 * @property {number|string} [teAero]
 * @property {number|string} [teAnaero]
 * @property {number} [rec]
 * @property {string} [conditions]
 * @property {number|string} [actualDist]
 * @property {number|string} [actualDur]
 * @property {Object} [stravaImport]
 * @property {number} [treadmillLTSpeed]
 * @property {string} [notes]
 * @property {string} [activityType]
 * @property {string} [name]
 * @property {{weekN:number, dayTag:string, sessionName:string}} [replacesPlannedDay]
 * @property {string} [swappedForName]
 * @property {string} [swappedAt]
 * @property {string} [performedMode]
 */

/**
 * A workout logged WITHOUT replacing a day's own WorkoutLog slot - see lib/extras.js.
 * Stored as a flat array under the single storage key 'extra-workouts', not one per day.
 * @typedef {Object} ExtraWorkout
 * @property {string} id
 * @property {string} date YYYY-MM-DD
 * @property {string} dayTag the calendar day it was logged for
 * @property {number} weekN
 * @property {boolean} [completed]
 * @property {boolean} [freeform]
 * @property {string} [completedAt] ISO datetime
 * @property {string} [activityType]
 * @property {string} [name]
 * @property {number|string} [actualDist]
 * @property {number|string} [actualDur]
 * @property {number|string} [avgHR]
 * @property {number|string} [rpe]
 * @property {string} [conditions]
 * @property {string} [notes]
 * @property {Object} [stravaImport]
 * @property {string} [retryOfTag] set when this is an explicit retry of a specific planned
 *   day (see openRetryPicker in ui/modals.js) - that day's own completed record is untouched
 */

/**
 * A fitness estimate snapshot for one of the three tiers (1=Garmin manual, 2=outdoor
 * Strava-verified, 3=indoor/treadmill).
 * @typedef {Object} TierEstimate
 * @property {number} [lthr]
 * @property {number} [ltPaceSec]
 * @property {number} [maxHR]
 * @property {number} [vo2max]
 * @property {number} [restHR]
 * @property {number} [suggestedNextSpeed]
 * @property {number} [suggestedNextVO2Speed]
 * @property {string} [basedOn]
 * @property {string} [updatedAt] ISO datetime
 */

/**
 * The current read on progress toward a race goal, either the fallback baseline
 * math or the coach's own synthesized reading (both share this shape).
 * @typedef {Object} GoalTrajectoryReading
 * @property {number} position 0-100: 0 is badly behind, 50 is on track, 100 is ahead
 * @property {string} confidence 'low'|'medium'|'high'
 * @property {string} label
 * @property {boolean} actionFlag
 * @property {string} source
 * @property {string|null} [updatedAt]
 * @property {string|null} [basedOn]
 * @property {number} [trend] change vs the previously saved position
 * @property {number} [projectedSec]
 * @property {number} [projectedPaceSec]
 * @property {number} [prevProjectedSec] projectedSec from the previously saved reading, if any
 * @property {number} [prevProjectedPaceSec] projectedPaceSec from the previously saved reading, if any
 * @property {string} [zoneKey] 'GOAL'|'RACE10K' - which activeGoals slot this reading is for, absent for the raceless maintenance reading
 * @property {string} [goalId] the activeGoals entry's stable id, absent for the raceless maintenance reading
 */

/**
 * @typedef {Object} CoachNote
 * @property {string} date ISO datetime
 * @property {number|null} weekN
 * @property {string|null} dayTag
 * @property {string} kind
 * @property {string} text
 * @property {string|null} goalImpact
 */

/**
 * One day's entry inside a dmetrics-{weekKey} blob (keyed by date string).
 * @typedef {Object} DailyMetricsEntry
 * @property {string} time
 * @property {string} [context]
 * @property {number|string} [sleep]
 * @property {number|string} [readiness]
 * @property {number|string} [hrv]
 * @property {string} [hrvStatus]
 * @property {string} [trainingStatus]
 * @property {string} [notes]
 */

export {};
