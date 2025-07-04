const Schedule = require('node-schedule');
const jobs = new Map();

function scheduleDeduction(serverId, date, jobCallback) {
  cancelDeduction(serverId);                       // kill old

  if (+date <= Date.now()) {                       // past-time guard
    return jobCallback();
  }

  const job = Schedule.scheduleJob(date, () => {
    try { jobCallback(); }
    finally { jobs.delete(serverId); }             // auto-cleanup
  });

  if (job) {
    jobs.set(serverId, job);
    console.log(`[Sched] ${serverId} next @ ${date.toISOString()}`);
  } else {
    console.warn(`[Sched] failed for ${serverId} (past date?)`);
  }
}

function cancelDeduction(serverId) {
  const job = jobs.get(serverId);
  if (job) { job.cancel(); jobs.delete(serverId); }
}

function cancelAll() {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
}

module.exports = { scheduleDeduction, cancelDeduction, cancelAll };
