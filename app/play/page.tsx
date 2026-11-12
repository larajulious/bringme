import { Mascot } from "@/components/brand/mascot";
import { RoomCodeForm } from "@/components/game/room-code-form";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function PlayPage() {
  return (
    <div className="relative my-auto mt-24 animate-rise short:mt-16 tiny:mt-12">
      <Mascot mood="happy" className="absolute -top-[5.75rem] left-1/2 w-32 -translate-x-1/2 short:-top-[4.25rem] short:w-24 tiny:-top-[3.4rem] tiny:w-20" />
      <Card className="pt-12 short:pt-8 tiny:pt-6">
        <CardHeader className="text-center short:pb-3">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight">Join a game</h1>
          <p className="text-muted-foreground">Scan the QR code on the big screen, or type the room code.</p>
        </CardHeader>
        <CardContent>
          <RoomCodeForm />
        </CardContent>
      </Card>
    </div>
  );
}
