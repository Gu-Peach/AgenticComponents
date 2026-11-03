(* 阅读顺序：先看 PROGRAM Palletizer 的主流程，再回看两个 FUNCTION_BLOCK。
   Palletizer 是码垛单元主程序，使用 Open-Industry 自定义的 LADDER 文本。
   PalletTruck 是搬运车步骤控制块，MutingSeq 是光幕顺序屏蔽演示块，两者使用 ST。
   主程序通过功能块实例调用它们。实例内部变量会跨扫描保存，调用不是从初始状态重跑。

   扫描方式：原演示由外部 MainTask 每 10 ms 调用一次 Palletizer；该任务配置不在本文件中。
   每次扫描从上到下求值，前面的赋值可被后面的梯级立即读到。等待靠保存状态并在后续扫描重查，
   不是让程序停在某一行。多个流程状态机每扫描都得到执行，因此可以协同推进。

   ST 读法：:= 赋值，= 比较；IF 按条件执行；CASE 根据当前整数状态选一支。
   VAR_INPUT 为块输入，VAR_OUTPUT 为块输出，VAR 为实例内部记忆。
   调用中 Pin := value 表示传入，Pin => variable 表示把输出接到变量。
   TON 是接通延时：IN 持续为真达到 PT 后 Q 为真，IN 为假时复位。
   R_TRIG / F_TRIG 分别检测上升沿 / 下降沿，Q 只在检测到变化的那次调用为真。

   工艺总览：纸箱输入 -> 两排组成一层 -> 机械臂整层抓取与堆叠 -> 满托盘输出
             -> 缠膜 -> 转台转向 -> 暂存线 -> 入库车送入货架。
   空托盘补给与下一层组排可和满托盘输出交叠运行。

   文件中的 ${...} 是 demoScenes.ts 的模板表达式，需要源项目展开后才能编译。
   路线、机器人任务、设备参数和标签接线也在场景中定义，本文件只保存 PLC 控制逻辑。
   这里的 safe、急停和光幕逻辑是仿真演示，不表示本文件是经过认证的安全控制程序。 *)

(* PalletTruck：用一个功能块复用两辆车的运输流程。
   每趟依次经过出发路点、5 行取料路线、中途路点、4 行放料路线、返程路点，最后回路线 0。
   Cmd 是路线表的行号，不是世界坐标。路线行包含位置、朝向和货叉高度，由设备执行器解释。
   Fork 在当前 AGV 实现中表示夹持/释放载荷，实际升降高度来自路线行，不能把 Fork 当作高度命令。
   Exec 置真后保持到观察到 Idle 变假，再清零；必须看到“离开空闲，再回到空闲”才能认定动作结束。
   Want/Grant 是通道申请与许可。本例两个调用都传 Grant=TRUE，没有实现共享通道仲裁。
   Slot 从 0 开始逐趟增加。末趟在 Step=32 结束返程路点后锁存 Done，再发回路线 0 的命令。
   因此 Done 不代表已回到原位；块内没有自动清除 Done 或重置 Slot 的逻辑。 *)
FUNCTION_BLOCK PalletTruck
VAR_INPUT
  Enable   : BOOL; (* 步骤推进许可，不等同于设备的受控停止输入 *)
  Request  : BOOL; (* 请求下一趟；只在 Step=0 且未 Done 时接收 *)
  Idle     : BOOL; (* 设备空闲反馈；必须先变假再变真才能完成一次移动 *)
  Grant    : BOOL; (* 共享通道许可，本演示始终传 TRUE *)
  PickBase : INT; (* 第一趟取料路线的首行编号 *)
  PickStride : INT; (* 相邻两趟取料首行间隔；0 为同一取料点 *)
  WayBase  : INT; (* 中途路点区域的首行编号 *)
  WayOut   : INT; (* 出发段路点行数 *)
  WayMid   : INT; (* 取料到放料之间的路点行数 *)
  WayIn    : INT; (* 放料后返程路点行数 *)
  DropBase : INT; (* 第一趟放料首行；每趟占 4 行 *)
  Slots    : INT; (* 总趟数/目标位置数，场景应提供正数 *)
END_VAR
VAR_OUTPUT
  Cmd  : INT; (* 交给设备的路线行号，0 表示回原位 *)
  Exec : BOOL; (* 执行触发，保持到观察到设备已启动 *)
  Fork : BOOL; (* TRUE 夹持载荷，FALSE 释放；货叉高度由路线行决定 *)
  Want : BOOL; (* 通道申请，整趟期间保持 *)
  Step : INT; (* 此车的工艺状态编号，不是路线行号 *)
  Slot : INT; (* 当前趟次/槽位索引，从 0 开始 *)
  Done : BOOL; (* 末趟结束时锁存，禁止继续接单；回路线 0 仍可能在途 *)
END_VAR
VAR
  Moving  : BOOL; (* 已发路线命令，等待完整忙闲握手 *)
  Started : BOOL; (* 本次命令后已看到 Idle=FALSE *)
  Send    : INT; (* 本扫描待发路线；-1 表示不发送 *)
  wi      : INT; (* 当前一段中途路点的循环索引 *)
  Lift    : TON; (* 夹持稳定等待 600 ms，不是货叉到位检测 *)
  Drop    : TON; (* 释放稳定等待 600 ms，不是物料交接确认 *)
  pk      : INT; (* 本趟取料路线首行，由 PickBase/Stride/Slot 算出 *)
END_VAR

(* 握手先于步骤机执行。Started 排除“命令刚下发、设备尚未离开 Idle”的假完成。 *)
IF Moving THEN
  IF NOT Idle THEN Started := TRUE; END_IF;
  IF Started THEN Exec := FALSE; END_IF;
  IF Started AND Idle THEN Moving := FALSE; END_IF;
END_IF;

(* 两个 TON 每扫描先调用，再执行 CASE。进入 Step=20/30 且移动结束后开始计时。
   Enable=FALSE 会把这两个计时器复位，但不复位 Step、Slot、Fork 或 Done。 *)
Lift(IN := Enable AND (Step = 20) AND NOT Moving, PT := T#600ms);
Drop(IN := Enable AND (Step = 30) AND NOT Moving, PT := T#600ms);

(* 本趟取料路线起点。PickStride=0 时各趟复用同一取料点；大于 0 时随 Slot 切换取料位置。
   Send=-1 表示本扫描不发新命令，只有 CASE 确实选出路线行才会在块末提交。 *)
pk :=PickBase + PickStride * Slot;
Send := -1;
(* 步骤路径：0 等请求 -> 5 等许可 -> 6 出发/取料首行 -> 12/14/16 取料后续行
   -> 20 夹持等待 -> 22 中途/放料首行 -> 24/25 放料后续行 -> 30 释放等待
   -> 32 返程及结束计数 -> 40 等回原位完成并释放通道申请。
   CASE 一次只执行选中的分支；Step 可以先指向下一阶段，Moving 再阻止提前发下一条路线。 *)
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
(* 统一发令入口：先写 Cmd，再拉高 Exec，并重置本次启动确认。无新命令时保留输出。 *)
IF Send >= 0 THEN
  Cmd := Send; Exec := TRUE; Moving := TRUE; Started := FALSE;
END_IF;
END_FUNCTION_BLOCK

(* MutingSeq：模拟单向物料经过光幕时的顺序屏蔽。
   沿输送方向排列为 A1 -> A2 -> 光幕。A1/A2 为真表示各自检测到遮挡；Ossd 为真表示光幕通畅。
   先仅遮挡 A1，再在 A1 仍遮挡时遮挡 A2，才进入 Muted。
   进入屏蔽后先记录物料确实遮过光幕，再等光幕和两只检测器全部恢复，结束屏蔽。
   MaxTime 限制屏蔽持续时间。它不检查 A1 到 A2 的最大间隔，也不验证人员与物料的身份。
   尾随遮挡可能延长屏蔽，代码不能被解释为完整安全功能块。 *)
FUNCTION_BLOCK MutingSeq
VAR_INPUT
  Enable  : BOOL; (* 启用顺序判定；为假时复位状态 *)
  Ossd    : BOOL; (* 光幕通畅为 TRUE，遮挡为 FALSE *)
  A1      : BOOL; (* 第一只物料检测器，遮挡为 TRUE *)
  A2      : BOOL; (* 第二只物料检测器，遮挡为 TRUE *)
  MaxTime : TIME; (* 连续屏蔽允许的最长时间 *)
END_VAR
VAR_OUTPUT
  Clear   : BOOL; (* 送给主流程的通行条件：光幕通畅或正在屏蔽 *)
  Muted   : BOOL; (* State=2，正在屏蔽光幕遮挡 *)
  Expired : BOOL; (* State=9，屏蔽已超时 *)
END_VAR
VAR
  State   : INT; (* 状态：0 等待物料；1 已先检测到 A1；2 正在屏蔽；9 屏蔽超时。 *)
  Broken  : BOOL; (* 记忆本次屏蔽期间光幕是否真正被遮挡过。 *)
  Limit   : TON; (* 只在屏蔽状态连续计时 *)
END_VAR

(* 这里的 State 只控制屏蔽流程。State=9 在 A1/A2 都清空时复位，不是必须人工复位的故障锁存。 *)
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
(* CASE 更新 State 后才调用计时器；进入 2 的本次扫描就开始计时，超时则立即转 9。 *)
Limit(IN := State = 2, PT := MaxTime);
IF Limit.Q THEN State := 9; END_IF;
Muted := State = 2;
Expired := State = 9;
(* Clear 只取决于光幕通畅或正在屏蔽；Expired 本身不额外锁死 Clear。 *)
Clear := Ossd OR Muted;
END_FUNCTION_BLOCK
(* 主程序的局部变量分为组排、机械臂、出料、补托盘、搬运车和指示灯几组。
   普通未显式初始化的 BOOL/INT 在本引擎中分别从 FALSE/0 开始，之后跨扫描保留。 *)

PROGRAM Palletizer
VAR
  running    : BOOL := TRUE; (* 启动自保持位；初始 TRUE，不是首次启动必须按 Start 的配置 *)
  CaseMuting : MutingSeq; (* 纸箱入口光幕实例 *)
  FeedMuting : MutingSeq; (* 空托盘入口光幕实例 *)
  OutMuting  : MutingSeq; (* 成品出口光幕实例 *)
  caseClear  : BOOL := TRUE; (* 纸箱入口允许通行 *)
  feedClear  : BOOL := TRUE; (* 空托盘入口允许通行 *)
  outClear   : BOOL := TRUE; (* 成品出口允许通行 *)

  InfeedSpeed : REAL := 1.0; (* 来箱输送的运行设定 *)
  RunSpeed   : REAL := 1.0; (* 组排输送的运行设定 *)
  ShiftRate  : REAL := 1.0; (* 推排链条的运行设定 *)
  safe       : BOOL; (* 供动作和输出使用的总运行许可 *)

  rowPhase   : INT; (* 0 第一排，1 第二排 *)
  rowsPushed : INT; (* 当前层已推入的排数，目标为 2 *)
  turnedFirst : BOOL; (* 当前层是否先做转向排 *)
  thisRowTurned : BOOL; (* 当前排是否转向 *)
  rowTarget  : INT; (* 当前排箱数，直排 2、转向排 3 *)
  rowSent    : INT; (* 当前排已检测的箱数 *)
  RowPacked  : TON; (* 箱数足够且到位后稳定等待 1 s *)
  rowDone    : BOOL; (* 本排满足启动推排的条件 *)
  shifting   : BOOL; (* 推排过程保持位 *)
  ShiftPulse : TON; (* 推排持续时间 2 s *)
  Raised     : TON; (* 升起推排机构后等待 200 ms *)
  Shifted    : R_TRIG; (* 检测推排计时完成沿，驱动排数加 1 *)
  layerDone  : BOOL; (* 两排已推入且层检测器确认到位 *)

  Step       : INT; (* 机械臂步骤：0 等层，10 等抓层完成，20 等放层完成 *)
  OutStep    : INT := 100; (* 出料步骤；100 起始等待，0 为可接下一轮出料 *)
  Moving     : BOOL; (* 机械臂任务在途；与 Truck.Moving 不同 *)
  Started    : BOOL; (* 已看到机械臂离开空闲 *)
  InPlace    : TON; (* 空托盘到位后等待 800 ms *)
  TurnSettle : TON; (* 转台托盘稳定等待 1.2 s *)
  LoadLeft   : F_TRIG; (* LoadOut 下降沿，表示成品尾部离开检测区 *)

  layerIdx   : INT; (* 下一待组层索引，0 到 COURSES-1 *)
  placeIdx   : INT; (* 本次机械臂正在放的层索引 *)
  palletFull : BOOL := TRUE; (* 组垛台暂不接收新层；初始 TRUE，由补空托盘完成后清除 *)
  picking    : BOOL; (* 正在抓层并抬离组层台，需阻止送料干涉 *)

  LineSpeed  : REAL := 0.4; (* 满托盘输送的运行设定 *)
  FeedSpeed  : REAL := 0.6; (* 空托盘输送的运行设定 *)
  PalletFeed : BOOL; (* 正在向组垛台补入空托盘 *)

  outRun     : BOOL; (* 向缠膜工位/转台输送的保持位 *)
  laneRun    : BOOL; (* 转台向暂存线输送的保持位 *)
  blocked    : BOOL; (* 满托盘等待暂存线腾空 *)

  Truck      : PalletTruck; (* 入库车功能块实例，保存自己的 Step/Slot/计时器 *)
  TruckStep  : INT; (* 入库车步骤监视值 *)
  TruckSlot  : INT; (* 入库车目标槽位索引 *)
  TruckDone  : BOOL; (* 入库车已完成全部目标位 *)
  Supply     : PalletTruck; (* 空托盘补给车的独立功能块实例 *)
  MagEmpty   : TON; (* 拆盘机缺料确认延时 1 s *)
  S3Step     : INT; (* 补给车步骤监视值 *)
  S3Slot     : INT; (* 补给车当前库存堆索引 *)
  S3Done     : BOOL; (* 补给车已用完配置的库存堆 *)

  (* 梯形图中间量：把数字比较结果保存为 BOOL，并保存进入各状态机前的步骤快照。 *)
  half, even : INT; (* half/even 用整数运算判定层索引奇偶 *)
  phase0, phase1 : BOOL; (* 第一排/第二排的 BOOL 条件 *)
  armNow, outNow : INT; (* 机械臂/出料状态机进入时的步骤快照 *)
  lastLayer, outIdle, layerStep : BOOL; (* 末层判定、出料空闲判定、放层步骤转换标记 *)
  request, resupply : BOOL; (* 入库请求 / 空托盘堆补给请求 *)
  feeding, shiftRun, outMoving, deckMoving, turnMoving, laneMoving, feedRun : BOOL; (* 各段输送许可中间量，用于选择运行速度或 0 *)

  (* 运行指示：控制运行许可亮灯，不是设备实际速度传感器。 *)
  RunLamp    : BOOL; (* 运行常亮指示 *)
  (* 闪烁时基：两个 TON 交替计时，形成约 0.5 s 亮、0.5 s 灭的节奏。 *)
  BlinkOn    : TON; (* 闪烁前半周期计时 *)
  BlinkOff   : TON; (* 闪烁后半周期计时 *)
  ready      : BOOL; (* 因跳停停机，且联锁已恢复可再启动 *)
  (* 导致运行许可掉落的联锁原因，不包括操作员正常按 Stop。 *)
  tripCause  : BOOL; (* 当前有联锁断开 *)
  (* 检测 running 从真变假的那一扫描。 *)
  RunFell    : F_TRIG; (* running 下降沿 *)
  (* 记录本次停机由联锁触发；重新运行后清除。 *)
  tripped    : BOOL; (* 因联锁跳停的记忆位 *)
  (* 所有急停输入正常时为真；输入按常闭回路语义解释。 *)
  eStopOk    : BOOL; (* 所有急停正常 *)
END_VAR(* 梯形图读法：每条以分号结束的语句是一条梯级，从左到右算条件，从上到下执行梯级。
   |X| 在 X=TRUE 时导通；|/X| 在 X=FALSE 时导通。串接是 AND，[支路1, 支路2] 是 OR。
   |P X| 为 X 上升沿，只导通一次。普通 (X) 每扫描把梯级结果写入 X；(S X)/(R X) 仅导通时置位/复位，
   梯级不通时 S/R 保持原值。它们与普通线圈的“梯级不通就写 FALSE”不同。
   EQ/NE/GE/LT 分别是等于/不等于/大于等于/小于；裸 OUT 将比较的 BOOL 结果作为梯级条件。
   MOVE/ADD 等在前方条件导通时执行，OUT => X 指定写入目标。
   T1(IN, PT := ...) 的裸 IN 接前方条件，默认输出 Q 接后续梯级；块仍会接收 FALSE 用于复位。
   对照例：|A| |/B| (C) 表示 C := A AND NOT B。 *)

LADDER
  (* 1. 总许可：五个急停正常信号串联，任意一个为假就使 eStopOk 为假。
     FlexRun 单独只受 eStopOk 控制，并不串联 running、Guard 或光幕。 *)
  |EStop| |EStopDock| |EStopGate| |EStopSupply| |EStopOutfeed| (eStopOk);
  |eStopOk| (FlexRun);
  (* 2. 分别处理纸箱入口、空托盘入口、成品出口的光幕。
     Enable 是接在梯级电源上的裸输入引脚，不是名为 Enable 的全局变量。
     这些调用在左端直接接电源，因此每扫描传入 Enable=TRUE；结果分别送至 Clear/Muted 变量。 *)
  CaseMuting(Enable, Ossd := CaseCurtain, A1 := CaseMuteA1, A2 := CaseMuteA2, MaxTime := T#30s, Clear => caseClear, Muted => CaseMuted);
  FeedMuting(Enable, Ossd := FeedCurtain, A1 := FeedMuteA1, A2 := FeedMuteA2, MaxTime := T#30s, Clear => feedClear, Muted => FeedMuted);
  OutMuting(Enable, Ossd := OutCurtain, A1 := OutMuteA1, A2 := OutMuteA2, MaxTime := T#30s, Clear => outClear, Muted => OutMuted);
  (* 3. 启停自保持，等价于：
     running := (Start OR running) AND Stop AND eStopOk AND Guard AND caseClear AND feedClear AND outClear。
     Stop=TRUE 表示按钮未按下，按下时为 FALSE；不要按名字误读为“TRUE 要求停机”。
     任意串联条件断开都会清除 running。运行期间联锁掉落后，仅恢复联锁不会自动重启，仍需 Start。
     但 running 的声明初值是 TRUE，本演示首次扫描在联锁全部正常时会保持运行。 *)
  [|Start|, |running|] |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (running);
  (* safe 复制运行许可，供后续驱动门控使用；它不是独立的实际安全状态检测结果。 *)
  |running| (safe);
  (* ArmEnable 交给机器人执行器实现保持/继续，Step 和已发出的任务不会在停机时自动清零。 *)
  |safe| (ArmEnable);
  (* CycleEnable 交给缠膜机、拆盘机、转台的设备执行器处理周期保持，停止/恢复细节由各设备实现。 *)
  |safe| (CycleEnable);
  (* 4. 组层排型：layerIdx 从 0 开始，奇数索引层先做转向排，偶数索引层先做直排。
     half=floor(layerIdx/2)，even=2*half，layerIdx!=even 表示奇数索引。
     rowPhase=0 为本层第一排，1 为第二排；两排方向相反。
     SEL：G=FALSE 选 IN0，G=TRUE 选 IN1，因此直排需 2 箱，转向排需 3 箱。 *)
  DIV(IN1 := layerIdx, IN2 := 2, OUT => half);
  MUL(IN1 := half, IN2 := 2, OUT => even);
  NE(IN1 := layerIdx, IN2 := even, OUT) (turnedFirst);
  EQ(IN1 := rowPhase, IN2 := 0, OUT) (phase0);
  EQ(IN1 := rowPhase, IN2 := 1, OUT) (phase1);
  [|turnedFirst| |phase0|, |/turnedFirst| |phase1|] (thisRowTurned);
  SEL(G := thisRowTurned, IN0 := 2, IN1 := 3, OUT => rowTarget);
  (* BoxAtEye 的上升沿只计数一次：rowSent 统计当前排，Cases 统计累计来箱数。检测器持续遮挡不重复加。 *)
  |P BoxAtEye| ADD(IN1 := rowSent, IN2 := 1, OUT => rowSent) ADD(IN1 := Cases, IN2 := 1, OUT => Cases);
  (* 5. 推排：当前排计数足够、RowReady 为真且没有推排/抓层时，RowPacked 连续计时 1 s。
     每层最多推两排。shifting 用自身保持，ShiftPulse 到 2 s 后解除；Raised 到 200 ms 才许可链条运行。
     第一排开始推时切换 rowPhase 并清空排计数；Shifted 检测 ShiftPulse.Q 上升沿，使完成排数只加一次。
     两排计数达到 2 且 LayerReady 为真，才认为一层就绪。
     这些计时/计数梯级没有全部串联 safe，运行许可掉落不意味着它们都冻结。 *)
  GE(IN1 := rowSent, IN2 := rowTarget, OUT) |RowReady| |/shifting| |/picking| RowPacked(IN, PT := T#1000ms);
  LT(IN1 := rowsPushed, IN2 := 2, OUT) |RowPacked.Q| |/shifting| (rowDone);
  [|rowDone|, |shifting|] |/ShiftPulse.Q| (shifting);
  |shifting| ShiftPulse(IN, PT := T#2000ms);
  |shifting| Raised(IN, PT := T#200ms);
(* shifting 在上面的梯级刚置真，本扫描下面的上升沿触点即可读到它，切换第二排计数。 *)
  EQ(IN1 := rowsPushed, IN2 := 0, OUT) |P shifting| MOVE(IN := 1, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent);
  |ShiftPulse.Q| Shifted(CLK) ADD(IN1 := rowsPushed, IN2 := 1, OUT => rowsPushed);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |Shifted.Q| MOVE(IN := 0, OUT => rowSent);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |LayerReady| (layerDone);
  (* 6. 机器人命令握手：Moving 记录有任务在途，Started 记录已看到 ArmIdle 变假。
     观察到开始后撤销 ArmExec；只有 Started 且 ArmIdle 再次为真才撤销 Moving。
     初始 ArmIdle=TRUE 不可直接算一次动作完成。本握手没有 request_id、错误分支或接受超时。 *)
  |Moving| |/ArmIdle| (S Started);
  |Moving| |Started| (R ArmExec);
  |Moving| |Started| |ArmIdle| (R Moving);
(* 补空托盘与转台稳定计时在状态机之前计算，LoadLeft 则每扫描检测成品离台沿。 *)
  |PalletFeed| |PalletIn| InPlace(IN, PT := T#800ms);
  EQ(IN1 := OutStep, IN2 := 115, OUT) TurnSettle(IN, PT := T#1200ms);
  |LoadOut| LoadLeft(CLK);
  (* 7. 机械臂状态机：先保存 armNow=Step，此后所有步骤条件读取 armNow。
     即使本扫描把 Step 改为 10，后面的步骤 10 也要等下次扫描，防止同一扫描跨多个步骤。
     ArmCmd=1 调用场景中的“抓整层并抬离”任务；ArmCmd=2+n 调用“放到第 n 层并归位”任务。
     这些任务的运动细节在机器人设备配置中，不在 PLC 中。 *)
  MOVE(IN := Step, OUT => armNow);
  GE(IN1 := placeIdx, IN2 := ${COURSES - 1}, OUT) (lastLayer);
  EQ(IN1 := OutStep, IN2 := 0, OUT) (outIdle);
  (* Step=0：等待 layerDone 且当前托盘可接收，保存本次 placeIdx，再发抓层任务。
     picking 在抓层阶段阻止组层台继续送料和推排，避免机械臂抓取时干涉。 *)
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| (R picking);
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| |layerDone| |/palletFull| MOVE(IN := layerIdx, OUT => placeIdx) MOVE(IN := 1, OUT => ArmCmd) MOVE(IN := 10, OUT => Step) (S ArmExec) (S Moving) (R Started) (S picking);
  (* Step=10：抓层任务完成后，组层台已可准备下一层，清空组排计数并推进 layerIdx。
     同时发出 placeIdx+2 的放层任务，清除 picking，使下一层组排与当前放层重叠。
     layerStep 是本次转换的普通线圈，用于只在转换时检查 layerIdx 的回绕。 *)
  EQ(IN1 := armNow, IN2 := 10, OUT) |safe| |/Moving| MOVE(IN := 0, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent) MOVE(IN := 0, OUT => rowsPushed) ADD(IN1 := layerIdx, IN2 := 1, OUT => layerIdx) ADD(IN1 := placeIdx, IN2 := 2, OUT => ArmCmd) MOVE(IN := 20, OUT => Step) (R picking) (S ArmExec) (S Moving) (R Started) (layerStep);
  GE(IN1 := layerIdx, IN2 := ${COURSES}, OUT) |layerStep| MOVE(IN := 0, OUT => layerIdx);
  (* Step=20：等待放层并归位完成。若不是最后一层，回 Step=0。
     若为最后一层，还需 OutStep=0，才启动出料 OutStep=100 并把 palletFull 置真。
     placeIdx 保留正在放置的层号，避免已提前递增的 layerIdx 干扰末层判断。 *)
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |lastLayer| |outIdle| MOVE(IN := 100, OUT => OutStep) MOVE(IN := 0, OUT => Step) (S palletFull);
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |/lastLayer| MOVE(IN := 0, OUT => Step);
  (* 8. 出料状态机：此处才保存 outNow=OutStep，位置在机械臂状态机之后。
     所以机械臂本扫描刚写入的 OutStep=100 可立即被这里看到；出料内部再用快照防止连续跳步。 *)
  MOVE(IN := OutStep, OUT => outNow);
  (* OutStep=100：等待暂存线不满，然后将转台目标设为 0 度，进入 105。
     Pallets 在此处加 1，是发起这一轮出料的计数，不是入库成功确认。
     OutStep 初始就是 100，因此启动阶段也会经过这一计数点。 *)
  EQ(IN1 := outNow, IN2 := 100, OUT) |safe| |/LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 105, OUT => OutStep) ADD(IN1 := Pallets, IN2 := 1, OUT => Pallets);
  (* OutStep=105：TurnDone 确认转台到目标角度后，锁存 outRun，开始向缠膜工位输送。 *)
  EQ(IN1 := outNow, IN2 := 105, OUT) |safe| |TurnDone| MOVE(IN := 106, OUT => OutStep) (S outRun);
  (* OutStep=106：WrapInPos 表示托盘到缠膜位置，关闭 outRun，并置位 WrapStart 发起缠膜周期。 *)
  EQ(IN1 := outNow, IN2 := 106, OUT) |safe| |WrapInPos| MOVE(IN := 107, OUT => OutStep) (R outRun) (S WrapStart);
  (* OutStep=107：WrapDone 表示缠膜周期完成，清除 WrapStart，再开启 outRun 送往转台。 *)
  EQ(IN1 := outNow, IN2 := 107, OUT) |safe| |WrapDone| MOVE(IN := 110, OUT => OutStep) (R WrapStart) (S outRun);
  (* OutStep=110：TurnEye 检测到托盘到达转台后关闭 outRun，进入 115。
     115 等 TurnSettle 连续计时 1.2 s，才发 -90 度转向命令；120 等 TurnDone，再开启 laneRun。
     计时器在上面的梯级已经调用，新写入的步骤要到下一扫描才影响它。 *)
  EQ(IN1 := outNow, IN2 := 110, OUT) |safe| |TurnEye| MOVE(IN := 115, OUT => OutStep) (R outRun);
  EQ(IN1 := outNow, IN2 := 115, OUT) |safe| |TurnSettle.Q| MOVE(IN := -90.0, OUT => TurnCmd) MOVE(IN := 120, OUT => OutStep);
  EQ(IN1 := outNow, IN2 := 120, OUT) |safe| |TurnDone| MOVE(IN := 130, OUT => OutStep) (S laneRun);
  (* OutStep=130：向暂存线输送，LaneFull 到位后关闭 laneRun，并命令转台回 0 度。 *)
  EQ(IN1 := outNow, IN2 := 130, OUT) |safe| |LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 140, OUT => OutStep) (R laneRun);
  (* OutStep=140：等待转台回正完成，再设 OutStep=0，允许下一轮满托盘出料。 *)
  EQ(IN1 := outNow, IN2 := 140, OUT) |safe| |TurnDone| MOVE(IN := 0, OUT => OutStep);
  (* 9. 补入空托盘：LoadLeft 检测 LoadOut 的下降沿，即成品尾部离开组垛台出口检测器。
     满托盘离开组垛台就锁存 PalletFeed，不必等它完成缠膜/转台流程。
     PalletIn 持续为真 800 ms 后清除 PalletFeed 和 palletFull，允许机械臂向新托盘放层。 *)
  |safe| |palletFull| |LoadLeft.Q| (S PalletFeed);
  |safe| |PalletFeed| |InPlace.Q| (R PalletFeed) (R palletFull);
  (* 10. 入库车：LaneFull 且 laneRun 已关闭，才申请搬走暂存线上的托盘。
     Truck 是 PalletTruck 的独立实例，safe 接它的 Enable 输入，块的第一个 BOOL 输出 Exec 接 RackExec。
     裸 Enable 不同于 EN：即使 safe=FALSE，功能块仍被调用，只是输入 Enable=FALSE。
     此时 CASE 不发新步骤，但顶部握手仍执行，Exec/Fork 不会被 Enable 自动清零，已接受的行驶也不由此停止。
     PickStride 未传入，实例默认值 0，使每趟都从同一暂存线取料；Grant=TRUE 表示不等待通道仲裁。 *)
  |LaneFull| |/laneRun| (request);
  |safe| Truck(Enable, Idle := RackIdle, Grant := TRUE, Request := request, PickBase := ${AGV_PICK_BASE}, WayBase := ${AGV_WAY_BASE}, WayOut := ${RACK_WAYS.out}, WayMid := ${RACK_WAYS.mid}, WayIn := ${RACK_WAYS.in}, DropBase := ${RACK_BAY_BASE}, Slots := ${RACK_SLOTS}, Cmd => RackCmd, Fork => RackFork, Step => TruckStep, Slot => TruckSlot, Done => TruckDone) (RackExec);
  (* 11. 补给车：MagLevel=0 且 PalletReady=FALSE 持续 1 s 后才补空托盘堆。
     这段延时避免拆盘机刚放下最后一块托盘、工位检测器尚未读到时过早补料。
     Supply 与 Truck 的状态互相独立。PickStride 使每趟从下一堆取料；WayOut/Mid/In=0 跳过中途路点。
     放料每趟仍递增 4 行，场景路线表为各趟提供重复的拆盘机放料路线。 *)
  EQ(IN1 := MagLevel, IN2 := 0, OUT) |/PalletReady| MagEmpty(IN, PT := T#1000ms);
  |MagEmpty.Q| (resupply);
  |safe| Supply(Enable, Idle := SupplyIdle, Grant := TRUE, Request := resupply, PickBase := ${SUPPLY.pickBase}, PickStride := ${SUPPLY.pickStride}, WayBase := 0, WayOut := 0, WayMid := 0, WayIn := 0, DropBase := ${SUPPLY.dropBase}, Slots := ${SUPPLY.slots}, Cmd => SupplyCmd, Fork => SupplyFork, Step => S3Step, Slot => S3Slot, Done => S3Done) (SupplyExec);
  (* 12. 设备输出：用 SEL 把速度门控为设定值或 0。
     feeding=safe AND NOT picking。组层台被抓层占用时停止进料；SpawnRun 另外受排数量和层就绪限制。
     速度值的具体比例/单位由对应设备参数解释，不把这里所有 REAL 都当成相同物理单位。 *)
  |safe| |/picking| (feeding);
  SEL(G := feeding, IN0 := 0.0, IN1 := InfeedSpeed, OUT => Infeed);
  SEL(G := feeding, IN0 := 0.0, IN1 := RunSpeed, OUT => RowForm);
  |safe| |shifting| |Raised.Q| (shiftRun);
  SEL(G := shiftRun, IN0 := 0.0, IN1 := ShiftRate, OUT => ShiftSpeed);
  LT(IN1 := rowSent, IN2 := rowTarget, OUT) |safe| |/layerDone| |/picking| (SpawnRun);
  (* LoadFlex 许可上料点继续放箱；FlexFull 只描述入口检测状态，不是整条柔性输送线所有区的占用总数。 *)
  |safe| |/FlexFull| (LoadFlex);
  |safe| |outRun| (outMoving);
  SEL(G := outMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => PalletOut);
  (* 组垛台 DeckRun 单独门控：成品离台后，即使下游 outRun 仍为真，也不能带走刚补入的空托盘。 *)
  |safe| |outRun| |palletFull| |/PalletFeed| (deckMoving);
  SEL(G := deckMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => DeckRun);
  |safe| [|outRun|, |laneRun|] (turnMoving);
  SEL(G := turnMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => TurnRun);
  |safe| |laneRun| (laneMoving);
  SEL(G := laneMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => Lane);
  (* 空托盘补入期间抬起横移机构；DispBusy 为假时才开进料/横移输送，避免与拆盘动作争用。 *)
  |safe| |PalletFeed| (PalletLift);
  |safe| |PalletFeed| |/DispBusy| (feedRun);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletInfeed);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletXfer);
  (* 不在补盘、工位无等待托盘且拆盘机空闲时，PalletDispense 请求先准备一块空托盘。 *)
  |safe| |/PalletFeed| |/PalletReady| |/DispBusy| (PalletDispense);
  (* Turn 是纸箱组排用的转向挡板，Shift 是推排链条升起；与成品转台的 TurnCmd/TurnRun/TurnDone 不同。 *)
  |safe| |thisRowTurned| (Turn);
  |shifting| |safe| (Shift);
  (* 13. 塔灯按位组合：1=绿、2=黄、4=红，可相加形成多灯同时亮。
     绿灯跟随运行许可；黄灯表示 OutStep=100 且 LaneFull，出料等待暂存线腾空。
     本演示红灯只由急停异常或 Guard 打开产生；光幕触发和正常 Stop 不直接置红灯。
     每扫描先清零 Tower，再累加当前灯位，避免上一扫描的灯位残留。 *)
  |safe| (RunLamp);
  EQ(IN1 := OutStep, IN2 := 100, OUT) |LaneFull| (blocked);
  MOVE(IN := 0, OUT => Tower);
  |RunLamp| ADD(IN1 := Tower, IN2 := 1, OUT => Tower);
  |blocked| ADD(IN1 := Tower, IN2 := 2, OUT => Tower);
  [|/eStopOk|, |/Guard|] ADD(IN1 := Tower, IN2 := 4, OUT => Tower);
  (* 14. Start 指示灯：运行时常亮；因联锁停机且联锁恢复后闪烁，提示可按 Start 继续。
     RunFell.Q AND tripCause 只在运行掉落的那一扫描锁存 tripped。
     正常 Stop 不算联锁跳停，已经停着时再触发联锁也不会新锁存 tripped。
     ready 要求运行关闭、tripped 已锁存且全部串联条件恢复。running 再次为真会清除 tripped。 *)
  |/BlinkOff.Q| BlinkOn(IN, PT := T#500ms);
  |BlinkOn.Q| BlinkOff(IN, PT := T#500ms);
  [|/eStopOk|, |/Guard|, |/caseClear|, |/feedClear|, |/outClear|] (tripCause);
  |running| RunFell(CLK);
  [|RunFell.Q| |tripCause|, |tripped|] |/running| (tripped);
  |/running| |tripped| |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (ready);
  [|RunLamp|, |ready| |BlinkOn.Q|] (StartLamp);
END_LADDER
END_PROGRAM

(* 控制器全局 I/O：场景设备按这些标签名连接 PLC。
   以下 VAR_INPUT 是 PLC 读取的设备反馈/按钮；VAR_OUTPUT 是 PLC 写给设备的命令及显示计数。
   它们与功能块内部的同名变量作用域不同。声明初值只是仿真启动值，随后由接线与程序更新。 *)
VAR_INPUT
  Start      : BOOL; (* 启动按钮，按下为 TRUE *)
  Stop       : BOOL := TRUE; (* 正常未按为 TRUE，按下为 FALSE *)
  EStop      : BOOL := TRUE; (* 操作台急停正常信号，按下为 FALSE *)
  EStopDock  : BOOL := TRUE; (* 卸货区急停正常信号 *)
  EStopGate  : BOOL := TRUE; (* 单元入口急停正常信号 *)
  EStopSupply : BOOL := TRUE; (* 空托盘补给区急停正常信号 *)
  EStopOutfeed : BOOL := TRUE; (* 出料区急停正常信号 *)
  Guard      : BOOL := TRUE; (* 防护门关闭为 TRUE *)
  CaseCurtain : BOOL := TRUE; (* 纸箱入口光幕通畅 *)
  FeedCurtain : BOOL := TRUE; (* 空托盘入口光幕通畅 *)
  OutCurtain : BOOL := TRUE; (* 成品出口光幕通畅 *)
  CaseMuteA1, CaseMuteA2 : BOOL; (* 纸箱入口两只顺序检测器，遮挡为 TRUE *)
  FeedMuteA1, FeedMuteA2 : BOOL; (* 空托盘入口两只顺序检测器 *)
  OutMuteA1, OutMuteA2 : BOOL; (* 成品出口两只顺序检测器 *)
  BoxAtEye   : BOOL; (* 单箱经过检测器 *)
  RowReady   : BOOL; (* 整排到挡停位置 *)
  LayerReady : BOOL; (* 整层在抓取位置就绪 *)
  ArmIdle    : BOOL; (* 机械臂任务空闲 *)
  TurnDone   : BOOL := TRUE; (* 转台到目标角度完成 *)
  TurnEye    : BOOL; (* 托盘到转台位置 *)
  LoadOut    : BOOL; (* 组垛台出口检测器有托盘遮挡 *)
  LaneFull   : BOOL; (* 暂存线取货位置有托盘 *)
  RackIdle   : BOOL := TRUE; (* 入库车空闲 *)
  SupplyIdle : BOOL := TRUE; (* 补给车空闲 *)
  PalletIn   : BOOL; (* 空托盘到组垛台挡停位置 *)
  DispBusy   : BOOL; (* 拆盘机正在执行周期 *)
  PalletReady : BOOL; (* 拆盘机出口已有待送空托盘 *)
  MagLevel   : INT := -1; (* 拆盘机库存数量；初值 -1 不会被误判为已确认空库 *)
  WrapInPos  : BOOL; (* 托盘到缠膜位置 *)
  WrapDone   : BOOL; (* 缠膜周期完成 *)
  FlexFull   : BOOL; (* 柔性输送线入口检测有料 *)
END_VAR
VAR_OUTPUT
  Infeed     : REAL; (* 来箱输送运行设定 *)
  RowForm    : REAL; (* 组排输送运行设定 *)
  ShiftSpeed : REAL; (* 推排链条运行设定 *)
  SpawnRun   : BOOL; (* 按当前排需求允许供箱 *)
  LoadFlex   : BOOL; (* 柔性输送线上料许可/指示 *)
  FlexRun    : BOOL; (* 柔性输送线运行许可，仅受 eStopOk 门控 *)
  Turn       : BOOL; (* 组排转向挡板动作 *)
  Shift      : BOOL; (* 推排链条升起 *)
  ArmCmd     : INT; (* 机器人任务编号：1 抓层，2+n 放第 n 层 *)
  ArmExec    : BOOL; (* 机器人任务执行触发 *)
  ArmEnable  : BOOL; (* 机器人运动许可/保持输入 *)
  PalletOut  : REAL; (* 满托盘出料输送设定 *)
  DeckRun    : REAL; (* 组垛台输送设定 *)
  TurnRun    : REAL; (* 转台上的辊道输送设定，不是旋转角度 *)
  TurnCmd    : REAL; (* 转台目标角度，0 或 -90 度 *)
  Lane       : REAL; (* 成品暂存线输送设定 *)
  RackCmd    : INT; (* 入库车路线行号 *)
  RackExec   : BOOL; (* 入库车执行触发 *)
  RackFork   : BOOL; (* 入库车载荷夹持/释放 *)
  SupplyCmd  : INT; (* 补给车路线行号 *)
  SupplyExec : BOOL; (* 补给车执行触发 *)
  SupplyFork : BOOL; (* 补给车载荷夹持/释放 *)
  PalletDispense : BOOL; (* 请求拆盘机放出一块空托盘 *)
  PalletLift : BOOL; (* 空托盘横移机构升起 *)
  PalletInfeed : REAL; (* 空托盘进料输送设定 *)
  PalletXfer : REAL; (* 空托盘横移输送设定 *)
  WrapStart  : BOOL; (* 缠膜周期启动，完成后复位 *)
  CycleEnable : BOOL; (* 缠膜机/拆盘机/转台周期运行许可 *)
  CaseMuted, FeedMuted, OutMuted : BOOL; (* 三个开口的光幕屏蔽状态/指示 *)
  StartLamp  : BOOL; (* 启动按钮灯：运行常亮，跳停恢复后闪烁 *)
  Tower      : INT; (* 塔灯位编码：1 绿、2 黄、4 红 *)
  Cases      : DINT; (* 累计来箱沿计数 *)
  Pallets    : DINT; (* 进入出料步骤 100 的计数，不代表完成入库 *)
END_VAR
